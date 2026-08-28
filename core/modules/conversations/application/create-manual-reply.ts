/**
 * 人工回复模块
 * 处理人工坐席在人工接管期间发送的消息。
 * 包含幂等性控制、接管权限校验和审计日志记录。
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { lockConversationOwnership } from "../../../infrastructure/postgres/ownership-lock.js";
import { scheduleMemoryCaptureInTransaction } from "../../memory/application/schedule-memory-capture.js";
import { conversationEvents } from "../../../infrastructure/events/conversation-events.js";

/** 人工回复的创建结果 */
export type ManualReplyResult =
  | {
      status: "accepted";
      created: boolean;
      message: typeof schema.messages.$inferSelect;
    }
  | { status: "conversation_not_found" }
  | { status: "handoff_not_assignee" }
  | { status: "conversation_revision_conflict"; conversationRevision: number }
  | { status: "idempotency_conflict" };

/** 人工回复的投递状态查询结果 */
export type ManualReplyOutcome =
  | { status: "not_found" }
  | {
      status: "pending" | "accepted" | "sent" | "failed";
      message: typeof schema.messages.$inferSelect;
    };

/** 查询人工回复消息的投递状态（pending/accepted/sent/failed）。
 *
 * 客户端可能以两种稳定标识查询：
 * - 下发时使用的 clientRequestId（UUID）——按 manual idempotency 键解析（向后兼容原契约）；
 * - 消息自身的稳定 messageId（agent-message:… / manual-message:<sha256>）——按 messageId 解析。
 * 前端在会话刷新后内存映射清空，会回退成用 messageId 查询，故两种都必须支持。
 */
export async function getManualReplyOutcome(
  db: NodePgDatabase<typeof schema>,
  input: { conversationId: string; clientRequestId: string },
): Promise<ManualReplyOutcome> {
  const isMessageId =
    input.clientRequestId.startsWith("agent-message:") ||
    input.clientRequestId.startsWith("manual-message:");
  const rows = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, input.conversationId),
        isMessageId
          ? eq(schema.messages.messageId, input.clientRequestId)
          : eq(schema.messages.idempotencyKey, `manual:${input.clientRequestId}`),
      ),
    )
    .limit(1);
  const message = rows[0];
  if (!message) return { status: "not_found" };
  const sendState = message.sendState;
  const status =
    sendState === "failed"
      ? "failed"
      : sendState === "sent" || sendState === "observed"
        ? "sent"
        : sendState === "pending"
          ? "pending"
          : "accepted";
  return { status, message };
}

/**
 * 创建人工回复消息。
 * 校验会话存在性和人工接管权限，通过幂等键防止重复提交。
 * 创建成功后触发内存捕获调度并记录审计事件。
 */
export async function createManualReply(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    actorUserId: string;
    text: string;
    clientRequestId: string;
    expectedConversationRevision?: number;
    sourceIp: string;
    /** 引用回复的原通道消息（ADR-0006 群聊引用） */
    replyToChannelMessageId?: string | null;
    /** @ 提及的通道联系人（ADR-0006 群聊 @） */
    mentionContactRefs?: string[];
    /** 出站媒体 id（先经 POST /api/v1/media 上传；携带时消息落库为媒体消息） */
    mediaId?: string | null;
    /** 出站媒体文件信息（mediaId 之外的发送所需元数据） */
    media?: { fileId: string; kind?: string } | null;
  },
): Promise<ManualReplyResult> {
  const result = await db.transaction(
    async (transaction): Promise<ManualReplyResult> => {
      // ownership 锁：与接管/结束/Agent 落库串行化；取锁后读取的 handoff 状态即权威
      await lockConversationOwnership(transaction, input.conversationId);
      const conversations = await transaction
        .select({
          channel: schema.conversations.channel,
          contactId: schema.conversations.contactId,
          revision: schema.conversations.revision,
        })
        .from(schema.conversations)
        .where(eq(schema.conversations.conversationId, input.conversationId))
        .limit(1);
      if (!conversations[0]) {
        return { status: "conversation_not_found" };
      }
      if (
        input.expectedConversationRevision !== undefined &&
        conversations[0].revision !== input.expectedConversationRevision
      ) {
        return {
          status: "conversation_revision_conflict",
          conversationRevision: conversations[0].revision,
        };
      }

      const handoffs = await transaction
        .select({
          status: schema.handoffStates.status,
          assignedUserId: schema.handoffStates.assignedUserId,
        })
        .from(schema.handoffStates)
        .where(eq(schema.handoffStates.conversationId, input.conversationId))
        .limit(1);
      const handoff = handoffs[0];
      if (
        handoff?.status !== "in_progress" ||
        handoff.assignedUserId !== input.actorUserId
      ) {
        return { status: "handoff_not_assignee" };
      }

      const messageId = manualMessageId(
        input.actorUserId,
        input.conversationId,
        input.clientRequestId,
      );
      const inserted = await transaction
        .insert(schema.messages)
        .values({
          messageId,
          conversationId: input.conversationId,
          channelEventId: null,
          channelMessageId: null,
          direction: "outbound",
          actorType: "user",
          actorId: input.actorUserId,
          contentType: input.mediaId ? "media" : "text",
          channelType: 1,
          text: input.text,
          isSelf: true,
          processingState: "not_applicable",
          sendState: "pending",
          replyToChannelMessageId: input.replyToChannelMessageId ?? null,
          mentionContactRefs: input.mentionContactRefs ?? [],
          idempotencyKey: `manual:${input.clientRequestId}`,
          occurredAt: new Date(),
          traceId: `manual-reply:${messageId}`,
        })
        .onConflictDoNothing()
        .returning();

      const created = inserted[0];
      if (created) {
        // 出站媒体：上传仅持有 storedFiles，这里创建 mediaAssets 关联到本条消息
        if (input.mediaId && input.media) {
          const now = new Date();
          await transaction
            .insert(schema.mediaAssets)
            .values({
              mediaId: input.mediaId,
              messageId: created.messageId,
              conversationId: input.conversationId,
              sourceConversationId: `manual-upload:${input.media.fileId}`,
              sourceLocalId: null,
              sourceMediaRef: null,
              kind: input.media.kind ?? "file",
              status: "ready",
              originalFileId: input.media.fileId,
              errorCode: null,
              description: null,
              processedAt: now,
              nextAttemptAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing();
        }
        await scheduleMemoryCaptureInTransaction(transaction, {
          conversationId: input.conversationId,
          contactId: conversations[0].contactId,
          watermarkMessageId: created.messageId,
        });
        await transaction.insert(schema.auditEvents).values({
          auditId: randomUUID(),
          actorUserId: input.actorUserId,
          eventType: "conversation.manual_reply_created",
          subjectType: "message",
          subjectId: messageId,
          sourceIp: input.sourceIp,
          metadata: {
            conversationId: input.conversationId,
            clientRequestId: input.clientRequestId,
          },
        });
        conversationEvents.publish({
          type: "human_message",
          conversationId: input.conversationId,
          messageId,
          occurredAt: new Date().toISOString(),
        });
        return { status: "accepted", created: true, message: created };
      }

      const existing = await transaction
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.messageId, messageId))
        .limit(1);
      const replay = existing[0];
      if (
        !replay ||
        replay.conversationId !== input.conversationId ||
        replay.actorId !== input.actorUserId ||
        replay.text !== input.text
      ) {
        return { status: "idempotency_conflict" };
      }
      return { status: "accepted", created: false, message: replay };
    },
  );
  return result;
}

/** 基于用户ID、会话ID和客户端请求ID生成确定性消息ID */
function manualMessageId(
  actorUserId: string,
  conversationId: string,
  clientRequestId: string,
): string {
  const digest = createHash("sha256")
    .update(`${actorUserId}\0${conversationId}\0${clientRequestId}`)
    .digest("hex");
  return `manual-message:${digest}`;
}
