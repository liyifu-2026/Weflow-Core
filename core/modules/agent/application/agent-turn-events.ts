import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { AgentTurnDatabase } from "./agent-turn-service.js";

export type AgentTurnEventType =
  | "ownership_checked"
  | "execution_resumed"
  | "tool_execution_reclaimed"
  | "tool_checkpoint_persisted"
  | "context_built"
  | "triaged"
  | "policy_decided"
  | "model_reasoning"
  | "knowledge_retrieved"
  | "tool_completed"
  | "draft_generated"
  | "validation_passed"
  | "validation_failed"
  | "handoff_created"
  | "reply_persisted"
  | "delivery_confirmed"
  | "delivery_unknown"
  | "delivery_failed"
  | "scheduled_send_created"
  | "scheduled_send_cancelled"
  | "model_call"
  /** FC：模型单轮请求了多个工具，仅首个被采纳（payload: dropped 工具名数组） */
  | "extra_tool_calls_dropped"
  /** FC 出口闸门：目录外工具名（幻觉 none/reply）→ 回喂无效工具回执并摘工具面重试 */
  | "invalid_tool_call_retry"
  /** 吸收式回合：回合运行中收到客户补充消息，作废本次决策、新上下文重决策 */
  | "turn_absorbed_input"
  /** 工具执行前的过程性短讯已落库（payload: segmentCount）；真 ReAct「说+做同发」 */
  | "tool_note_persisted"
  /** 过程性短讯被软闸丢弃（超条数/校验失败；工具照常执行），payload: reason */
  | "tool_note_suppressed"
  /** 发送期插话闸门扣留批次（payload: replyBatchId/variant/heldFromSequence/interjectionCount）；
   *  与总线事件 reply_interrupted 同刻落库的那一条——总线是瞬时的，事后只能查这里 */
  | "reply_held"
  /** 回合内续步回复已落库（payload: stepIndex/segmentCount；reply 无 wait_ms 续循环） */
  | "reply_step_persisted"
  /** 轮次执行抛错（重试前落库；payload: errorCode/message），排错统一入口 */
  | "turn_error"
  /** 队列重试耗尽等终态失败（payload: errorCode/handoffReason） */
  | "turn_failed";

export async function recordAgentTurnEvent(
  db: NodePgDatabase<typeof schema> | AgentTurnDatabase,
  input: {
    turnId: string;
    conversationId: string;
    eventType: AgentTurnEventType;
    reasonCode?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  await db.insert(schema.agentTurnEvents).values({
    eventId: `turn-event:${randomUUID()}`,
    turnId: input.turnId,
    conversationId: input.conversationId,
    eventType: input.eventType,
    reasonCode: input.reasonCode,
    payload: input.payload ?? {},
  });
}
