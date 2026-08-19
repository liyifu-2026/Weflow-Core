/**
 * 出站消息处理模块
 * 将待发送的消息通过通道发送操作投递到目标渠道。
 * 支持按回复批次顺序发送、发送操作对账和状态回写。
 */

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type {
  ChannelSendOperation,
  ChannelSendOperations,
} from "../../channel/contracts/channel-send-operations.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";

/**
 * 处理待发送的出站消息。
 * 保证同一回复批次内消息按序发送，通过正式 Channel Send seam 创建或查询发送操作，
 * 并将发送状态回写到数据库。
 */
export async function processOutboundMessages(
  db: NodePgDatabase<typeof schema>,
  client: ChannelSendOperations,
  options: { conversationId?: string } = {},
): Promise<void> {
  const messages = await db
    .select({
      messageId: schema.messages.messageId,
      conversationId: schema.messages.conversationId,
      channelConversationId: schema.conversations.channelConversationId,
      text: schema.messages.text,
      sendState: schema.messages.sendState,
      sendOperationId: schema.messages.sendOperationId,
      sendError: schema.messages.sendError,
      replyBatchId: schema.messages.replyBatchId,
      replySequence: schema.messages.replySequence,
      actorType: schema.messages.actorType,
    })
    .from(schema.messages)
    .innerJoin(
      schema.conversations,
      eq(schema.conversations.conversationId, schema.messages.conversationId),
    )
    .where(
      and(
        inArray(schema.messages.sendState, [
          "pending",
          "submitting",
          "unknown",
        ]),
        options.conversationId
          ? eq(schema.messages.conversationId, options.conversationId)
          : undefined,
      ),
    )
    .orderBy(asc(schema.messages.createdAt))
    .limit(20);

  for (const message of messages) {
    if (message.replyBatchId && (message.replySequence ?? 1) > 1) {
      const prior = await db
        .select({
          messageId: schema.messages.messageId,
          text: schema.messages.text,
        })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.replyBatchId, message.replyBatchId),
            lt(schema.messages.replySequence, message.replySequence ?? 1),
            // 只在前面分段仍「待发送/发送中」时阻塞；unknown/held/failed 等
            // 终态不再挡住后续分段
            inArray(schema.messages.sendState, ["pending", "submitting"]),
          ),
        )
        .limit(1);
      const firstPrior = prior[0];
      if (firstPrior) {
        // 即使乐观行仍 pending/submitting，若事件同步已产生 delivered 副本
        // （消息实际已送达渠道），后续分段不应被永久阻塞。
        const delivered = await db
          .select({ messageId: schema.messages.messageId })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.conversationId, message.conversationId),
              eq(schema.messages.text, firstPrior.text),
              eq(schema.messages.sendState, "observed"),
              eq(schema.messages.isSelf, true),
            ),
          )
          .limit(1);
        if (delivered.length === 0) continue;
      }
    }

    // AI Kill Switch 最终硬门（代码级，不依赖 Turn 侧判断）：
    // 按消息来源分类——human/system（含程序化 handoff 确认语）永远允许；
    // agent 消息在 auto_send_enabled OFF 时绝对禁止发送。
    // fresh 读真值，即使 Turn 事务在开关翻转前已提交 outbound 也能拦住。
    // 已 pending 的 AI 出站置为 held（终态，恢复开关后不自动补发，不重复生成）。
    if (message.actorType === "agent" && message.sendState !== "unknown") {
      const runtime = await readRuntimeSettings(db, undefined, {
        fresh: true,
      });
      if (!runtime.autoSendEnabled) {
        await db
          .update(schema.messages)
          .set({ sendState: "held", sendUpdatedAt: new Date() })
          .where(eq(schema.messages.messageId, message.messageId));
        continue;
      }
    }

    let operationId = message.sendOperationId;
    if (!operationId) {
      // 没有 operationId 的 unknown 无法安全对账；保持原状态，绝不生成替代操作。
      if (message.sendState === "unknown") continue;
      operationId = operationIdForMessage(message.messageId);
      await db
        .update(schema.messages)
        .set({
          sendOperationId: operationId,
          sendState: "submitting",
          sendUpdatedAt: new Date(),
        })
        .where(eq(schema.messages.messageId, message.messageId));
    }

    const reconciliation = await reconcileSendOperation(client, {
      operationId,
      conversationId: message.channelConversationId,
      text: message.text,
      sendState: message.sendState ?? "pending",
    });
    if (reconciliation.outcome === "unknown") {
      await db
        .update(schema.messages)
        .set({
          sendState: "unknown",
          sendError: reconciliation.error ?? message.sendError,
          sendUpdatedAt: new Date(),
        })
        .where(eq(schema.messages.messageId, message.messageId));
      continue;
    }
    await applySendOperation(
      db,
      message.messageId,
      message.conversationId,
      reconciliation.operation,
    );
  }
}

type ReconcileSendOperationInput = {
  operationId: string;
  conversationId: string;
  text: string;
  sendState: string;
};

type ReconcileSendOperationResult =
  | {
      outcome: "resolved";
      operation: ChannelSendOperation;
    }
  | {
      outcome: "unknown";
      error?: string;
    };

/**
 * 通过稳定 operationId 对账出站文本操作。
 * unknown 且源端查不到原操作时保持 unknown，禁止自动创建替代操作。
 */
export async function reconcileSendOperation(
  client: ChannelSendOperations,
  input: ReconcileSendOperationInput,
): Promise<ReconcileSendOperationResult> {
  const existing = await client.get(input.operationId);
  if (existing) {
    return matchesSendOperation(existing, input)
      ? { outcome: "resolved", operation: existing }
      : {
          outcome: "unknown",
          error: "send_operation_identity_conflict",
        };
  }

  if (input.sendState === "unknown") {
    return { outcome: "unknown" };
  }

  const created = await client.create({
    operationId: input.operationId,
    conversationRef: input.conversationId,
    payload: { kind: "text", text: input.text },
  });
  return matchesSendOperation(created, input)
    ? { outcome: "resolved", operation: created }
    : {
        outcome: "unknown",
        error: "send_operation_identity_conflict",
      };
}

function matchesSendOperation(
  operation: ChannelSendOperation,
  input: ReconcileSendOperationInput,
): boolean {
  return (
    operation.operationId === input.operationId &&
    sendOperationMatches(operation, input.conversationId, input.text)
  );
}

/** 校验 Channel 发送操作是否与本地消息的会话和内容一致 */
export function sendOperationMatches(
  operation: ChannelSendOperation,
  conversationId: string,
  text: string,
): boolean {
  return (
    operation.conversationRef === conversationId &&
    operation.payload.kind === "text" &&
    operation.payload.text === text
  );
}

/** 基于消息ID生成确定性发送操作ID（s2_ 前缀） */
export function operationIdForMessage(messageId: string): string {
  return `s2_${createHash("sha256").update(messageId).digest("hex")}`;
}

/** 将 Channel 发送操作结果同步回本地消息记录，处理渠道消息ID冲突 */
async function applySendOperation(
  db: NodePgDatabase<typeof schema>,
  messageId: string,
  conversationId: string,
  operation: ChannelSendOperation,
): Promise<void> {
  if (operation.channelMessageId) {
    const collision = await db
      .select({ messageId: schema.messages.messageId })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.channelMessageId, operation.channelMessageId),
          eq(schema.messages.conversationId, conversationId),
          ne(schema.messages.messageId, messageId),
        ),
      )
      .limit(1);
    if (collision.length > 0) {
      await db
        .update(schema.messages)
        .set({
          sendState: "unknown",
          sendError: "send_operation_channel_message_conflict",
          sendUpdatedAt: new Date(),
        })
        .where(eq(schema.messages.messageId, messageId));
      return;
    }
  }
  const sendState =
    operation.state === "pending" ? "submitting" : operation.state;
  await db
    .update(schema.messages)
    .set({
      sendState,
      sendError: operation.error,
      sendUpdatedAt: new Date(operation.updatedAt),
      channelMessageId: operation.channelMessageId,
    })
    .where(eq(schema.messages.messageId, messageId));
}
