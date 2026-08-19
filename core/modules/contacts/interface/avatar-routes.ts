/**
 * 联系人头像模块 HTTP 路由
 *
 * GET /api/v1/contacts/:contactId/avatar —— 联系人头像代理端点。
 * 只接受 contactProfiles 中已存且在部署方配置的白名单内的头像 URL
 * （防 SSRF），带缓存拉取后返回图片字节；无头像/URL 失效时统一 404，
 * 由前端降级。
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import type { AvatarProxyService } from "../application/avatar-proxy-service.js";

const avatarParamsSchema = z.object({
  contactId: z.string().trim().min(1).max(600),
});

/** 注册联系人头像模块的所有 HTTP 路由 */
export function registerContactAvatarRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  service: AvatarProxyService,
): void {
  server.get("/api/v1/contacts/:contactId/avatar", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const params = avatarParamsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const rows = await db
      .select({ avatarUrl: schema.contactProfiles.avatarUrl })
      .from(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, params.data.contactId))
      .limit(1);
    const avatarUrl = rows[0]?.avatarUrl;
    // 无头像或 URL 不在配置的白名单内：一律 404，不暴露内部原因
    if (!avatarUrl || !service.isAllowedAvatarUrl(avatarUrl)) {
      return reply.code(404).send({ error: "avatar_not_found" });
    }
    const result = await service.fetch(avatarUrl);
    if (result.state === "not_found") {
      return reply.code(404).send({ error: "avatar_not_found" });
    }
    if (result.state === "failed") {
      return reply.code(502).send({ error: "avatar_upstream_failed" });
    }
    reply.header("content-type", result.mimeType);
    reply.header("cache-control", "private, max-age=3600");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(Buffer.from(result.body));
  });
}
