/**
 * WeKnora 桥接路由：控制台「平台管理」内嵌界面的免密登录交换。
 *
 * launch（weflow cookie 会话）→ 一次性 code（60s，单次有效）
 * → bridge 页跨源 POST exchange（code）→ WeKnora 代管会话载荷
 * → bridge 写入 WeKnora UI 的 localStorage 后跳转目标页。
 *
 * redirect：浏览器 GET 入口，要求 weflow 业务身份（cookie/Bearer），
 * 服务端预检账号后 302 到 WeKnora bridge.html，bridge.html 复用 exchange 拿到会话。
 * 与 launch 共享同一份 code 暂存（模块级），保证两种入口都走同一审计。
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
  /** WeKnora 站点 origin（无 /api/v1 后缀）；用于 /knora/redirect 302 跳转 */
  origin: string | undefined;
};

const CODE_TTL_MS = 60_000;

type LaunchCode = { userId: string; expiresAt: number };

/**
 * 一次性 code 暂存：模块级单例，使 redirect 也能消费 launch 发出的 code。
 * 单进程内存（与现状一致）；TTL 60s，消费即删除。测试可通过 resetLaunchCodes() 隔离。
 */
const codes = new Map<string, LaunchCode>();

/** 签发一次性 code（60s TTL） */
function issueCode(userId: string): string {
  const code = randomBytes(24).toString("base64url");
  codes.set(code, { userId, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

/** 消费 code：返回 userId 或 null（不存在/过期/已消费） */
function consumeCode(code: string): string | null {
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code);
  return entry.expiresAt >= Date.now() ? entry.userId : null;
}

/** 测试辅助：清空 code 暂存，避免跨用例污染 */
export function resetLaunchCodes(): void {
  codes.clear();
}

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
      avatarPreset: user.avatarPreset,
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

  /**
   * 浏览器入口：要求 weflow 业务身份（cookie / Bearer）→
   * 预检代管账号（与 /launch 一致：注册冲突时返回 409 JSON，由前端引导一次性绑定）→
   * 签发 code 并 302 到 WeKnora 站点 bridge.html；bridge 跨源 exchange 走与 /launch 相同的 code 暂存。
   *
   * target 查询参数：bridge.html 落点（默认 /）；api 参数：bridge 调 exchange 用的 weflow 源，
   * 不传则默认用请求 origin（与现有 iframe 桥接一致）。
   */
  server.get("/api/v1/knora/redirect", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    if (!service) {
      return reply.code(503).send({ error: "knora_bridge_unavailable" });
    }
    if (!options.origin) {
      return reply.code(503).send({
        error: "knora_origin_unconfigured",
        message:
          "WeKnora 站点 origin 未配置（设置 WEKNORA_ORIGIN 或保证 WEKNORA_BASE_URL 含 /api/v1 后缀）",
      });
    }
    try {
      await service.sessionFor(identity.user);
    } catch (reason) {
      if (reason instanceof KnoraBootstrapRequiredError) {
        // 与 /launch 一致：浏览器场景下用 409 JSON 暴露 expectedEmail，
        // 前端拿到后引导 bootstrap（POST /api/v1/knora/bootstrap）。
        return reply.code(409).send({
          error: "knora_bootstrap_required",
          email: reason.expectedEmail,
        });
      }
      request.log.error({ err: reason }, "knora bridge redirect failed");
      return reply.code(502).send({ error: "knora_bridge_failed" });
    }
    const code = issueCode(identity.user.userId);
    const query = (request.query ?? {}) as { target?: unknown; api?: unknown };
    const target =
      typeof query.target === "string" && query.target.startsWith("/")
        ? query.target
        : "/";
    const api =
      typeof query.api === "string" && /^https?:\/\//.test(query.api)
        ? query.api
        : `${request.protocol}://${request.headers.host ?? ""}`;
    const url = new URL(
      `${options.origin}/bridge.html`,
    );
    url.searchParams.set("code", code);
    url.searchParams.set("target", target);
    url.searchParams.set("api", api);
    return reply.redirect(url.toString(), 302);
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
