/**
 * 联系人资料 HTTP 路由
 * 提供联系人资料的查询和更新 API 端点。
 */

import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  getConversationContactProfile,
  updateConversationContactProfile,
} from "../application/contact-profile-service.js";
import {
  listContactConversationsCursor,
  listContactsWithLatestConversation,
} from "../../conversations/application/query-conversations.js";

const paramsSchema = z.object({
  conversationId: z.string().min(1).max(300),
});
const contactParamsSchema = z.object({
  contactId: z.string().trim().min(1).max(600),
});
const contactHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().min(1).optional(),
});
const contactListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().min(1).optional(),
  /**
   * 关键字搜索：匹配 channelDisplayName / channelNickname /
   * channelRemark / sharedAlias；空字符串视为不过滤。
   */
  q: z.string().trim().max(120).optional(),
  /**
   * 联系人白名单过滤：true=仅白名单 / false=仅非白名单 / 不传=全部
   */
  agentEnabled: z
    .union([z.literal("true"), z.literal("false")])
    .transform((value) => value === "true")
    .optional(),
});
const patchSchema = z
  .object({
    note: z.string().trim().max(2_000).nullable().optional(),
    tags: z
      .array(z.string().trim().min(1).max(50))
      .max(50)
      .transform((tags) => [...new Set(tags)])
      .optional(),
    agentEnabled: z.boolean().optional(),
    sharedAlias: z.string().trim().min(1).max(120).nullable().optional(),
    /** 黑名单：true = 不建 Turn / 不进会话列表 / 不推通知 */
    blocked: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);

/** 注册联系人资料相关的 HTTP 路由 */
export function registerContactProfileRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
): void {
  // 联系人通讯录（按联系人聚合最近可见会话）
  server.get("/api/v1/contacts", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const query = contactListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const page = await listContactsWithLatestConversation(db, {
      userId: identity.user.userId,
      limit: query.data.limit,
      before: query.data.before,
      ...(query.data.q !== undefined && query.data.q.length > 0
        ? { q: query.data.q }
        : {}),
      ...(query.data.agentEnabled !== undefined
        ? { agentEnabled: query.data.agentEnabled }
        : {}),
    });
    return { contacts: page.items, nextCursor: page.nextCursor };
  });

  server.get(
    "/api/v1/contacts/:contactId/conversations",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = contactParamsSchema.safeParse(request.params);
      const query = contactHistoryQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const page = await listContactConversationsCursor(db, {
        contactId: params.data.contactId,
        userId: identity.user.userId,
        limit: query.data.limit,
        before: query.data.before,
      });
      return {
        conversations: page.items,
        nextCursor: page.nextCursor,
      };
    },
  );

  server.get(
    "/api/v1/conversations/:conversationId/contact-profile",
    async (request, reply) => {
      if (!(await requireBusinessIdentity(db, request, reply))) return;
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const profile = await getConversationContactProfile(
        db,
        params.data.conversationId,
      );
      return profile
        ? { profile }
        : reply.code(404).send({ error: "conversation_not_found" });
    },
  );

  server.patch(
    "/api/v1/conversations/:conversationId/contact-profile",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      const patch = patchSchema.safeParse(request.body);
      if (!params.success || !patch.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const result = await updateConversationContactProfile(db, {
        conversationId: params.data.conversationId,
        actorUserId: identity.user.userId,
        sourceIp: request.ip,
        patch: patch.data,
      });
      return result.status === "ok"
        ? { profile: result.profile }
        : reply.code(404).send({ error: "conversation_not_found" });
    },
  );
}
