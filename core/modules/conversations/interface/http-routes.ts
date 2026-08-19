/**
 * 会话 HTTP 路由
 * 提供会话列表、消息记录查询、已读标记和人工回复等 API 端点。
 * 所有路由均需业务身份认证。
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import * as databaseSchema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  createManualReply,
  getManualReplyOutcome,
} from "../application/create-manual-reply.js";
import {
  decodeCursor,
  getSharedTranscript,
  listHiddenConversations,
  listSharedConversations,
  markConversationRead,
  searchSharedConversations,
  setConversationHidden,
} from "../application/query-conversations.js";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  contactId: z.string().trim().min(1).max(600).optional(),
  scope: z.enum(["attention", "mine", "others", "all"]).optional(),
  before: z.string().min(1).optional(),
});
const searchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const transcriptParams = z.object({
  conversationId: z.string().min(1).max(300),
});
const transcriptQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().min(1).optional(),
});
const manualReplyBody = z
  .object({
    text: z.string().trim().min(1).max(4_000),
    clientRequestId: z.uuid(),
    expectedConversationRevision: z.number().int().min(0).optional(),
  })
  .strict();
const readBody = z
  .object({ lastReadMessageId: z.string().min(1).max(600) })
  .strict();
const visibilityBody = z.object({ hidden: z.boolean() }).strict();

/** 注册会话相关的 HTTP 路由 */
export function registerConversationRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
): void {
  server.get("/api/v1/conversations", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const query = listQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = await listSharedConversations(db, {
      limit: query.data.limit,
      userId: identity.user.userId,
      ...(query.data.contactId !== undefined
        ? { contactId: query.data.contactId }
        : {}),
      ...(query.data.scope !== undefined ? { scope: query.data.scope } : {}),
      ...(query.data.before !== undefined ? { before: query.data.before } : {}),
    });
    return {
      conversations: result.conversations,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  });

  /**
   * Console 能力声明。capability 未开启时，Console 维持只读降级；
   * 开启 → permissions 字段必须完整存在，缺失即只读（fail-safe）。
   */
  server.get("/api/v1/console/capabilities", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    return { capabilities: { conversationPermissions: true } };
  });

  server.get("/api/v1/conversations/search", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const query = searchQuery.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    return {
      conversations: await searchSharedConversations(db, {
        userId: identity.user.userId,
        query: query.data.q,
        limit: query.data.limit,
      }),
    };
  });

  server.get("/api/v1/conversations/hidden", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    return {
      conversations: await listHiddenConversations(db, identity.user.userId),
    };
  });

  server.post(
    "/api/v1/conversations/:conversationId/visibility",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = transcriptParams.safeParse(request.params);
      const body = visibilityBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const visibility = await setConversationHidden(db, {
        userId: identity.user.userId,
        conversationId: params.data.conversationId,
        hidden: body.data.hidden,
      });
      if (!visibility)
        return reply.code(404).send({ error: "conversation_not_found" });
      await db.insert(databaseSchema.auditEvents).values({
        auditId: randomUUID(),
        actorUserId: identity.user.userId,
        eventType: body.data.hidden
          ? "conversation.hidden"
          : "conversation.restored",
        subjectType: "conversation",
        subjectId: params.data.conversationId,
        sourceIp: request.ip,
        metadata: { hidden: String(body.data.hidden) },
      });
      return { visibility };
    },
  );

  server.get(
    "/api/v1/conversations/:conversationId/messages",
    async (request, reply) => {
      if (!(await requireBusinessIdentity(db, request, reply))) return;
      const params = transcriptParams.safeParse(request.params);
      const query = transcriptQuery.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const before = query.data.before
        ? decodeCursor(query.data.before)
        : undefined;
      if (query.data.before && !before) {
        return reply.code(400).send({ error: "invalid_cursor" });
      }
      return getSharedTranscript(
        db,
        params.data.conversationId,
        query.data.limit,
        before,
      );
    },
  );

  server.post(
    "/api/v1/conversations/:conversationId/read",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = transcriptParams.safeParse(request.params);
      const body = readBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const readState = await markConversationRead(db, {
        userId: identity.user.userId,
        conversationId: params.data.conversationId,
        lastReadMessageId: body.data.lastReadMessageId,
      });
      return readState
        ? { readState }
        : reply.code(404).send({ error: "message_not_found" });
    },
  );

  server.post(
    "/api/v1/conversations/:conversationId/messages",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = transcriptParams.safeParse(request.params);
      const body = manualReplyBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const result = await createManualReply(db, {
        conversationId: params.data.conversationId,
        actorUserId: identity.user.userId,
        text: body.data.text,
        clientRequestId: body.data.clientRequestId,
        ...(body.data.expectedConversationRevision === undefined
          ? {}
          : {
              expectedConversationRevision:
                body.data.expectedConversationRevision,
            }),
        sourceIp: request.ip,
      });
      if (result.status === "conversation_not_found") {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
      if (result.status === "handoff_not_assignee") {
        return reply.code(403).send({ error: "handoff_not_assignee" });
      }
      if (result.status === "conversation_revision_conflict") {
        return reply.code(409).send({
          error: "conversation_revision_conflict",
          conversationRevision: result.conversationRevision,
        });
      }
      if (result.status === "idempotency_conflict") {
        return reply.code(409).send({ error: "idempotency_conflict" });
      }
      return reply.code(202).send({
        message: result.message,
        replayed: !result.created,
      });
    },
  );

  server.get(
    "/api/v1/conversations/:conversationId/messages/outcome",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = transcriptParams.safeParse(request.params);
      const query = z
        .object({ clientRequestId: z.uuid() })
        .safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      return getManualReplyOutcome(db, {
        conversationId: params.data.conversationId,
        clientRequestId: query.data.clientRequestId,
      });
    },
  );
}
