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
import { MAX_REPLY_SEGMENTS } from "../../agent/application/decision-contract.js";
import { dedupeReplySegments } from "../../agent/application/policy-gate.js";

type DatabaseTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

type MessageDatabase = NodePgDatabase<typeof schema> | DatabaseTransaction;

/**
 * 回复批次变体（决定幂等 ID 后缀，同 turn 各变体互不碰撞）：
 * - direct：fresh 决策的最终回复
 * - tool_result：工具结果回喂后的最终回复
 * - tool_note：工具执行前附带的过程性短讯（"稍等，我看下后台。"）
 * - step：回合内续步回复（reply 不带 wait_ms 继续循环时，第 N 步说的话）
 */
export type AgentReplyVariant = "direct" | "tool_result" | "tool_note" | "step";

/**
 * 解析 agent 回复批次 ID（createAgentReply 构造格式的唯一镜像；格式
 * 变更必须两处同步）。非 agent-reply 前缀（如 handoff-farewell）返回
 * null。出站插话闸门用它从批次行反查 turnId 与变体。
 */
export function parseAgentReplyBatchId(
  replyBatchId: string,
): { turnId: string; variant: AgentReplyVariant } | null {
  const prefix = "agent-reply:";
  if (!replyBatchId.startsWith(prefix)) return null;
  const rest = replyBatchId.slice(prefix.length);
  if (rest.endsWith(":tool-result")) {
    return {
      turnId: rest.slice(0, -":tool-result".length),
      variant: "tool_result",
    };
  }
  if (rest.endsWith(":tool-note")) {
    return {
      turnId: rest.slice(0, -":tool-note".length),
      variant: "tool_note",
    };
  }
  const stepMarker = ":step:";
  const stepIndex = rest.lastIndexOf(stepMarker);
  if (
    stepIndex !== -1 &&
    /^\d+$/.test(rest.slice(stepIndex + stepMarker.length))
  ) {
    return { turnId: rest.slice(0, stepIndex), variant: "step" };
  }
  return { turnId: rest, variant: "direct" };
}

export type CreateAgentReplyInput = {
  conversationId: string;
  turnId: string;
  traceId: string;
  segments: string[];
  variant: AgentReplyVariant;
  /** step 变体必填：步号（从 1 起），进入幂等 ID（agent-message:{turnId}:step:{N}:{seq}）。 */
  stepIndex?: number;
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

  if (input.variant === "step" && !Number.isInteger(input.stepIndex)) {
    throw new Error("agent_reply_step_index_required");
  }
  // 落库边界去重（批内逐字重复段保留首条）：批内自重复既躲得过跨批守卫
  // （只比「整批 vs 上一条批次」），也不会被任何模型提示词稳定拦住——在
  // 这里收口，所有落库路径（最终回复/续步/过程短讯/nudge/定时发送）统一生效。
  const segments = dedupeReplySegments(input.segments);
  const suffix =
    input.variant === "tool_result"
      ? ":tool-result"
      : input.variant === "tool_note"
        ? ":tool-note"
        : input.variant === "step"
          ? `:step:${String(input.stepIndex)}`
          : "";
  const replyBatchId = `agent-reply:${input.turnId}${suffix}`;
  const values = segments.map((text, index) => {
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
  if (segments.length < 1 || segments.length > MAX_REPLY_SEGMENTS) {
    throw new Error("reply_segment_count_invalid");
  }
  if (segments.some((segment) => segment.trim().length === 0)) {
    throw new Error("reply_segment_empty");
  }
  if (segments.some((segment) => segment.length > 500)) {
    throw new Error("reply_segment_too_long");
  }
}
