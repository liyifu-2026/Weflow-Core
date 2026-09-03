/**
 * 决策字段契约单点定义。
 *
 * Agent 决策的 JSON 输出契约（字段名、枚举值）此前同时存在于三处：
 * agent-decision.ts 的 zod schema、平台兜底系统提示词（reply-policy）、
 * 各 Solution 的 Execution Strategy 提示词，一致性只靠人肉同步。
 * 本模块把枚举值提取为单一事实源：zod schema 与提示词文案都从这里
 * 派生，schema 演进时提示词不会再漂移。
 */

/** 模型可选择的下一动作（与 zod schema 的 next_action 枚举同源）。 */
export const NEXT_ACTION_VALUES = [
  "reply",
  "ask_for_information",
  "retrieve_knowledge",
  "call_tool",
  "handoff",
  "no_action",
] as const;

/** no_action 必填的原因码（与 zod schema 的 no_action_reason 枚举同源）。 */
export const NO_ACTION_REASONS = [
  "message_not_actionable",
  "waiting_for_user",
  "duplicate_event",
  "handoff_active",
  "agent_disabled",
  "superseded",
  "policy_suppressed",
] as const;

/** 决策可携带的字段清单（提示词文案的权威顺序）。 */
export const DECISION_FIELD_CONTRACT: readonly string[] = [
  "reply_segments（可选，1 到 3 个完整信息块；或旧字段 reply_text）",
  "next_action（reply|ask_for_information|retrieve_knowledge|call_tool|handoff|no_action）",
  "no_action_reason（next_action 为 no_action 时必填：message_not_actionable|waiting_for_user|duplicate_event|handoff_active|agent_disabled|superseded|policy_suppressed）",
  "requires_human（布尔值）",
  "risk_level（low|medium|high）",
  "handoff_briefing（可选，转人工时提供 {problem_summary, unresolved_items, suggested_first_reply}）",
  "knowledge_query（retrieve_knowledge 时必填）",
  "tool（call_tool 时提供 {name, arguments}，arguments 仅包含字符串值）",
];

/**
 * 生成"只输出以下字段"提示词句子。
 * 用于平台兜底系统提示词；Solution Strategy 可拼接自己的扩展字段。
 */
export function decisionFieldContractText(): string {
  return `只输出以下字段（未列出的字段一律不输出）：\n  ${DECISION_FIELD_CONTRACT.join("、")}`;
}
