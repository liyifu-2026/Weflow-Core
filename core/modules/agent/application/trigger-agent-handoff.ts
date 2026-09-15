/**
 * Agent-triggered Handoff module.
 *
 * When the agent decides that human takeover is needed, this module creates a
 * Handoff record that pauses automatic agent replies for the conversation.
 */

import { createHash } from "node:crypto";

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
