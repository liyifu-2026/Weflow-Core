/**
 * Agent-triggered Handoff module.
 *
 * When the agent decides that human takeover is needed, this module creates a
 * Handoff record that pauses automatic agent replies for the conversation.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { createHandoff } from "../../handoff/application/handoff-service.js";
import { buildHandoffBriefing } from "../../handoff/application/handoff-briefing.js";

/**
 * 内部交接原因代码 → 面向会话展示的友好摘要。
 * 原始代码仍保留在 briefing.handoffReason 供排查，summary 被友好化。
 */
const HANDOFF_REASON_LABELS: Array<[prefix: string, label: string]> = [
  ["model_unavailable", "自动回复服务暂时不可用，已转交人工处理"],
  ["policy_gate_after_tool", "回复校验未通过，已转交人工处理"],
  ["policy_gate", "回复校验未通过，已转交人工处理"],
  ["auto_send_disabled", "自动发送已被运营关闭，会话已转交人工处理"],
  ["tool_chain_limit", "自动处理步骤达到上限，已转交人工处理"],
  ["tool_failure", "自动处理失败，已转交人工处理"],
  ["agent_recommended", "自动处理无法安全继续，已转交人工处理"],
];

export function humanizeHandoffSummary(reason: string): string {
  const hit = HANDOFF_REASON_LABELS.find(([prefix]) =>
    reason.startsWith(prefix),
  );
  return hit ? hit[1] : reason;
}

export function agentHandoffClientRequestId(turnId: string): string {
  return `agent-handoff-${createHash("sha256").update(turnId).digest("hex").slice(0, 22)}`;
}

/**
 * 触发 Agent 转人工操作
 * @param db 数据库实例
 * @param conversationId 会话 ID
 * @param turnId 当前 Agent 轮次 ID
 * @param reason 转人工原因
 * @param briefing 可选的交接摘要（问题概要、未解决事项等）
 * @param assignedQueueId 可选的定向路由队列（缺省 = 通用）
 */
export async function triggerAgentHandoff(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
  turnId: string,
  reason: string,
  briefing?: schema.HandoffBriefing,
  assignedQueueId?: string | null,
): Promise<void> {
  const [conversation] = await db
    .select({ revision: schema.conversations.revision })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, conversationId))
    .limit(1);
  const result = await createHandoff(db, {
    conversationId,
    actorUserId: "system-agent",
    clientRequestId: agentHandoffClientRequestId(turnId),
    summary: humanizeHandoffSummary(reason).slice(0, 1_000),
    sourceIp: "core",
    agentTurnId: turnId,
    assignedQueueId: assignedQueueId ?? null,
    briefing:
      briefing ?? // 如果没有提供摘要，则构建一个默认的空摘要
      buildHandoffBriefing({
        sourceConversationRevision: conversation?.revision ?? 0,
        handoffReason: reason,
      }),
  });
  // invalid_transition 表示已经是转人工状态，不算失败
  if (result.status !== "ok" && result.status !== "invalid_transition") {
    throw new Error(`agent handoff failed: ${result.status}`);
  }
}
