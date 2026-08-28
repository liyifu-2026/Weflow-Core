/**
 * 会话 HTTP 路由
 * 提供会话列表、消息记录查询、已读标记、人工回复和拍一拍等 API 端点。
 * 所有路由均需业务身份认证。
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import * as databaseSchema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import { requireAdminIdentity } from "../../identity/interface/request-authentication.js";
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

/** Channel Host 连接配置（拍一拍端点需要） */
export type ChannelHostConfig = {
  baseUrl: string;
  token: string;
};

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  contactId: z.string().trim().min(1).max(600).optional(),
  scope: z.enum(["attention", "mine", "others", "all"]).optional(),
  /**
   * 联系人白名单过滤：
   * - `true`  → 仅返回 agentEnabled=true 的会话（工作区视图使用）
   * - `false` → 仅返回 agentEnabled=false 的会话（只读联系人视图过滤来源）
   * - 不传   → 全部会话（保持向后兼容）
   */
  agentEnabled: z
    .union([z.literal("true"), z.literal("false")])
    .transform((value) => value === "true")
    .optional(),
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
    text: z
      .string()
      .max(4_000)
      .optional()
      .transform((v) => (v?.trim() || "")),
    clientRequestId: z.uuid(),
    expectedConversationRevision: z.number().int().min(0).optional(),
    /** 出站媒体（ADR：人工回复携带媒体）；mediaId 来自 POST /api/v1/media 上传 */
    mediaId: z.string().regex(/^media:[a-f0-9]{64}$/).optional(),
    /** 上传返回的媒体元数据（fileId/kind），用于落 mediaAssets */
    media: z
      .object({
        fileId: z.string().trim().min(1).max(36),
        kind: z.enum(["image", "file", "voice", "video"]).optional(),
      })
      .optional(),
    /** 引用回复的原通道消息（ADR-0006 群聊引用） */
    replyToChannelMessageId: z.string().trim().min(1).max(300).optional(),
    /** @ 提及的通道联系人（ADR-0006 群聊 @） */
    mentionContactRefs: z.array(z.string().trim().min(1).max(256)).max(50).optional(),
  })
  .strict()
  .refine(
    (data) => data.text.trim().length > 0 || data.mediaId || data.media,
    { message: "text_required_for_non_media_messages", path: ["text"] },
  );
const readBody = z
  .object({ lastReadMessageId: z.string().min(1).max(600) })
  .strict();
const visibilityBody = z.object({ hidden: z.boolean() }).strict();

/** 注册会话相关的 HTTP 路由 */
export function registerConversationRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  channelHost?: ChannelHostConfig,
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
      ...(query.data.agentEnabled !== undefined
        ? { agentEnabled: query.data.agentEnabled }
        : {}),
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
        ...(body.data.mediaId ? { mediaId: body.data.mediaId } : {}),
        ...(body.data.media
          ? {
              media: {
                fileId: body.data.media.fileId,
                ...(body.data.media.kind ? { kind: body.data.media.kind } : {}),
              },
            }
          : {}),
        ...(body.data.replyToChannelMessageId
          ? { replyToChannelMessageId: body.data.replyToChannelMessageId }
          : {}),
        ...(body.data.mentionContactRefs
          ? { mentionContactRefs: body.data.mentionContactRefs }
          : {}),
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
        .object({
          clientRequestId: z.union([
            z.uuid(),
            z.string().regex(/^agent-message:[a-zA-Z0-9:_-]+$/),
            z.string().regex(/^manual-message:[a-f0-9]{64}$/),
          ]),
        })
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

  /**
   * 同步端点（管理员）：请求 Channel Host 以 historical 回溯通道重扫微信
   * 历史。补到的漏捕消息按 historical 事件摄取——只入库展示，绝不触发
   * Agent Turn / 记忆 / 通知（零副作用）；已入库消息由消息表唯一约束
   * 去重，不会重复。回溯异步执行，立即返回 started。
   */
  server.post("/api/v1/admin/channel/sync", async (request, reply) => {
    const identity = await requireAdminIdentity(db, request, reply);
    if (!identity) return;
    if (!channelHost) {
      return reply.code(503).send({ error: "channel_host_not_configured" });
    }
    try {
      const response = await fetch(`${channelHost.baseUrl}/api/v1/channel/sync`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${channelHost.token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return reply.code(response.status).send({
          error: "channel_sync_failed",
          message: response.statusText,
        });
      }
      const result = (await response.json()) as { started?: boolean };
      return reply.send({
        synced: true,
        started: result.started ?? false,
      });
    } catch (error) {
      return reply.code(502).send({
        error: "channel_host_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * 拍一拍端点：触发对会话联系人的拍一拍动作。
   * 直接调用 Channel Host 的 send API，不创建本地消息记录；
   * 拍一拍结果通过事件轮询从 Channel Host 同步回来。
   */
  server.post(
    "/api/v1/conversations/:conversationId/poke",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      if (!channelHost) {
        return reply.code(503).send({ error: "channel_host_not_configured" });
      }
      const params = transcriptParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const conversationId = params.data.conversationId;
      // 验证会话存在且用户有接管权限
      const conversation = await db
        .select({
          channelConversationId: databaseSchema.conversations.channelConversationId,
          channelAccount: databaseSchema.conversations.channelAccount,
        })
        .from(databaseSchema.conversations)
        .where(eq(databaseSchema.conversations.conversationId, conversationId))
        .limit(1);
      if (!conversation[0]) {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
      const handoff = await db
        .select({
          status: databaseSchema.handoffStates.status,
          assignedUserId: databaseSchema.handoffStates.assignedUserId,
        })
        .from(databaseSchema.handoffStates)
        .where(eq(databaseSchema.handoffStates.conversationId, conversationId))
        .limit(1);
      if (
        !handoff[0] ||
        handoff[0].status !== "in_progress" ||
        handoff[0].assignedUserId !== identity.user.userId
      ) {
        return reply.code(403).send({ error: "handoff_not_assignee" });
      }
      // 生成确定性 operationId 并调用 Channel Host
      const operationId = `poke:${randomUUID()}`;
      const channelConversationId = conversation[0].channelConversationId;
      const account = conversation[0].channelAccount;
      try {
        const response = await fetch(
          `${channelHost.baseUrl}/api/v1/channel/send`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${channelHost.token}`,
            },
            body: JSON.stringify({
              operationId,
              conversationRef: channelConversationId,
              payload: { kind: "poke" },
              ...(account ? { account } : {}),
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          return reply.code(response.status).send({
            error: "poke_failed",
            message: (error as { error?: string }).error ?? response.statusText,
          });
        }
        const result = await response.json();
        return reply.code(202).send({ poke: result });
      } catch (error) {
        return reply.code(502).send({
          error: "channel_host_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
