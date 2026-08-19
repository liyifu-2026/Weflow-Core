/**
 * 重复回复守卫
 *
 * 在生成回复落库前，将新回复与上一条已发送的 Agent 回复做内容比对，
 * 逐字相同时由调用方拦截，防止模型复读自己的上一条回复。
 */
import { and, asc, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

type DatabaseTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

/** 规范化回复文本用于重复比较：去除首尾空白并压缩连续空白 */
export function normalizeReplyText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * 判断新回复是否与上一条已发送的 Agent 回复内容重复。
 * 上一条回复按整批比较（replyBatchId 内按 replySequence 顺序拼接）。
 */
export async function isDuplicateOfLastReply(
  db: NodePgDatabase<typeof schema> | DatabaseTransaction,
  conversationId: string,
  replyText: string,
): Promise<boolean> {
  const previous = await lastAgentReplyText(db, conversationId);
  if (previous === null) return false;
  return normalizeReplyText(replyText) === normalizeReplyText(previous);
}

/** 查询会话内最近一条 Agent 回复批次的完整文本，无历史回复时返回 null */
async function lastAgentReplyText(
  db: NodePgDatabase<typeof schema> | DatabaseTransaction,
  conversationId: string,
): Promise<string | null> {
  const latest = await db
    .select({
      replyBatchId: schema.messages.replyBatchId,
      replySequence: schema.messages.replySequence,
      text: schema.messages.text,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.direction, "outbound"),
        eq(schema.messages.actorType, "agent"),
      ),
    )
    .orderBy(desc(schema.messages.occurredAt), desc(schema.messages.messageId))
    .limit(1);
  const last = latest[0];
  if (!last) return null;
  if (!last.replyBatchId || last.replySequence === null) {
    return last.text;
  }
  const batch = await db
    .select({
      replySequence: schema.messages.replySequence,
      text: schema.messages.text,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.replyBatchId, last.replyBatchId),
      ),
    )
    .orderBy(asc(schema.messages.replySequence));
  return batch.map((row) => row.text).join("\n\n");
}
