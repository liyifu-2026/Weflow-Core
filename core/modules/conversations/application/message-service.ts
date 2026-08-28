/**
 * Agent Reply Message domain boundary.
 *
 * This service owns only the persistence invariants for Agent-generated
 * outbound messages. Callers remain responsible for policy, ownership,
 * Agent Turn, and Memory decisions.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

type DatabaseTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

type MessageDatabase = NodePgDatabase<typeof schema> | DatabaseTransaction;

export type AgentReplyVariant = "direct" | "tool_result";

export type CreateAgentReplyInput = {
  conversationId: string;
  turnId: string;
  traceId: string;
  segments: string[];
  variant: AgentReplyVariant;
  /**
   * AI 员工标识（可选，平台不解释）。提供时作为 actor_id 落库，
   * 前端据此渲染该 AI 员工的专属头像；缺省保持 null（通用 Agent 标识）。
   */
  actorId?: string;
};

export type CreateAgentReplyResult = {
  created: boolean;
  messages: (typeof schema.messages.$inferSelect)[];
};

/**
 * Creates one deterministic Agent reply batch in the caller's transaction.
 *
 * The database schema has no agent_turn_id or trigger_message_id column on
 * messages. Existing behavior therefore binds the reply to its Agent Turn
 * through deterministic message IDs, idempotency keys, replyBatchId, and the
 * caller's turn lifecycle update.
 */
export async function createAgentReply(
  db: MessageDatabase,
  input: CreateAgentReplyInput,
): Promise<CreateAgentReplyResult> {
  validateSegments(input.segments);

  const suffix = input.variant === "tool_result" ? ":tool-result" : "";
  const replyBatchId = `agent-reply:${input.turnId}${suffix}`;
  const values = input.segments.map((text, index) => {
    const sequence = index + 1;
    const messageId = `agent-message:${input.turnId}${suffix}:${String(sequence)}`;
    return {
      messageId,
      conversationId: input.conversationId,
      channelEventId: null,
      channelMessageId: null,
      direction: "outbound" as const,
      actorType: "agent" as const,
      actorId: input.actorId ?? null,
      contentType: "text" as const,
      channelType: 1,
      text,
      isSelf: true,
      processingState: "not_applicable" as const,
      sendState: "pending" as const,
      replyBatchId,
      replySequence: sequence,
      idempotencyKey: messageId,
      occurredAt: new Date(),
      traceId: input.traceId,
    };
  });

  const inserted = await db
    .insert(schema.messages)
    .values(values)
    .onConflictDoNothing()
    .returning();

  const existingById = await db
    .select()
    .from(schema.messages)
    .where(
      inArray(
        schema.messages.messageId,
        values.map((value) => value.messageId),
      ),
    );
  for (const existing of existingById) {
    const expected = values.find(
      (value) => value.messageId === existing.messageId,
    );
    if (
      !expected ||
      existing.conversationId !== expected.conversationId ||
      existing.text !== expected.text ||
      existing.replyBatchId !== expected.replyBatchId ||
      existing.replySequence !== expected.replySequence ||
      existing.idempotencyKey !== expected.idempotencyKey
    ) {
      throw new Error("agent_reply_idempotency_conflict");
    }
  }

  const messages = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, input.conversationId),
        eq(schema.messages.replyBatchId, replyBatchId),
      ),
    )
    .orderBy(asc(schema.messages.replySequence));

  if (messages.length !== values.length) {
    throw new Error("agent_reply_idempotency_conflict");
  }

  return { created: inserted.length > 0, messages };
}

function validateSegments(segments: string[]): void {
  if (segments.length < 1 || segments.length > 3) {
    throw new Error("reply_segment_count_invalid");
  }
  if (segments.some((segment) => segment.trim().length === 0)) {
    throw new Error("reply_segment_empty");
  }
  if (segments.some((segment) => segment.length > 500)) {
    throw new Error("reply_segment_too_long");
  }
}
