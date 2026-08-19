/**
 * WeKnora 桥接路由：控制台「平台管理」内嵌界面的免密登录交换。
 *
 * launch（weflow cookie 会话）→ 一次性 code（60s，单次有效）
 * → bridge 页跨源 POST exchange（code）→ WeKnora 代管会话载荷
 * → bridge 写入 WeKnora UI 的 localStorage 后跳转目标页。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  KnoraAccountService,
  KnoraBootstrapRequiredError,
} from "../application/knora-account-service.js";
import { makeSecretBox } from "../application/secret-box.js";

export type KnoraBridgeOptions = {
  weknora: { baseUrl: string; apiKey: string; timeoutMs: number } | undefined;
  encKey: string | undefined;
  tenantId: number;
  emailDomain: string;
};

const CODE_TTL_MS = 60_000;

type LaunchCode = { userId: string; expiresAt: number };

export function registerKnoraBridgeRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  options: KnoraBridgeOptions,
): void {
  const service =
    options.weknora && options.encKey
      ? new KnoraAccountService(
          db,
          options.weknora,
          makeSecretBox(options.encKey),
          options.tenantId,
          options.emailDomain,
        )
      : null;

  // 一次性 code 暂存（单进程内存即可；TTL 60s，消费即删除）
  const codes = new Map<string, LaunchCode>();
  const issueCode = (userId: string): string => {
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { userId, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  };
  const consumeCode = (code: string): string | null => {
    const entry = codes.get(code);
    if (!entry) return null;
    codes.delete(code);
    return entry.expiresAt >= Date.now() ? entry.userId : null;
  };

  /** 会话载荷生成 + 审计；bootstrap 需求抛给调用方按 409 处理 */
  async function resolveSession(
    userId: string,
    actorUserId: string | null,
    sourceIp: string | null,
  ): Promise<unknown> {
    if (!service) throw new Error("knora bridge unavailable");
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.userId, userId))
      .limit(1);
    if (!user || user.status !== "active") {
      throw new Error("weflow user unavailable");
    }
    const payload = await service.sessionFor({
      userId: user.userId,
      username: user.username,
      role: user.role as "admin" | "operator",
      mustChangePassword: user.mustChangePassword,
      avatarUrl: null,
      displayName: user.displayName,
      tags: user.tags,
    });
    await db.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId,
      eventType: "knora.session_exchanged",
      subjectType: "user",
      subjectId: userId,
      sourceIp,
      metadata: { email: service.emailFor(user.username) },
    });
    return payload;
  }

  server.post("/api/v1/knora/launch", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    if (!service) {
      return reply.code(503).send({ error: "knora_bridge_unavailable" });
    }
    // 预检代管账号：注册冲突（已存在的 WeKnora 账号）提前引导一次性绑定
    try {
      await service.sessionFor(identity.user);
    } catch (reason) {
      if (reason instanceof KnoraBootstrapRequiredError) {
        return reply.code(409).send({
          error: "knora_bootstrap_required",
          email: reason.expectedEmail,
        });
      }
      request.log.error({ err: reason }, "knora bridge launch failed");
      return reply.code(502).send({ error: "knora_bridge_failed" });
    }
    return reply.send({ code: issueCode(identity.user.userId), expiresIn: 60 });
  });

  /** 跨源端点：bridge 页凭一次性 code 换取会话载荷（无 cookie，走 CORS 白名单） */
  server.post("/api/v1/knora/exchange", async (request, reply) => {
    if (!service) {
      return reply.code(503).send({ error: "knora_bridge_unavailable" });
    }
    const body = (request.body ?? {}) as { code?: string };
    const userId =
      typeof body.code === "string" ? consumeCode(body.code) : null;
    if (!userId) {
      return reply.code(401).send({ error: "invalid_or_expired_code" });
    }
    let payload: unknown;
    try {
      payload = await resolveSession(userId, userId, request.ip);
    } catch (reason) {
      if (reason instanceof KnoraBootstrapRequiredError) {
        return reply.code(409).send({
          error: "knora_bootstrap_required",
          email: reason.expectedEmail,
        });
      }
      request.log.error({ err: reason }, "knora bridge exchange failed");
      return reply.code(502).send({ error: "knora_bridge_failed" });
    }
    return reply.send(payload);
  });

  /** 一次性绑定：为已存在的 WeKnora 账号输入一次密码，换取代管凭证 */
  server.post("/api/v1/knora/bootstrap", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    if (!service) {
      return reply.code(503).send({ error: "knora_bridge_unavailable" });
    }
    const body = (request.body ?? {}) as { password?: string };
    if (!body.password || body.password.length < 1) {
      return reply.code(400).send({ error: "password_required" });
    }
    try {
      await service.bootstrap(identity.user, body.password);
    } catch (reason) {
      // 401 = 密码错误；其余按上游故障处理
      const status =
        typeof reason === "object" &&
        reason !== null &&
        "status" in reason &&
        reason.status === 401
          ? 401
          : 502;
      request.log.warn(
        { err: reason, status },
        "knora bridge bootstrap failed",
      );
      return reply.code(status).send({
        error: status === 401 ? "invalid_password" : "knora_bridge_failed",
      });
    }
    await db.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: identity.user.userId,
      eventType: "knora.account_bootstrap",
      subjectType: "user",
      subjectId: identity.user.userId,
      sourceIp: request.ip,
      metadata: { email: service.emailFor(identity.user.username) },
    });
    return reply.send({ ok: true });
  });
}
