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
  "wait",
  "end_session",
  "schedule_send",
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
  "noise",
  "listening",
] as const;

/** wait 动作参数边界：30 秒 ~ 15 分钟。 */
export const WAIT_MS_RANGE = { min: 30_000, max: 15 * 60_000 } as const;

/**
 * schedule_send 动作参数边界（SCHEDULED-SEND-PLAN 决策 #4/#7）：
 * 到点须在未来 1 分钟 ~ 30 天内；内容仅 text（文件/图片/群发禁入）。
 */
export const SCHEDULE_SEND_RANGE = {
  minAheadMs: 60_000,
  maxAheadMs: 30 * 24 * 60 * 60_000,
  maxContentLength: 2_000,
} as const;

/** 决策可携带的字段清单（提示词文案的权威顺序）。 */
export const DECISION_FIELD_CONTRACT: readonly string[] = [
  "reply_segments（可选，1 到 3 个完整信息块；或旧字段 reply_text）",
  "next_action（reply|ask_for_information|retrieve_knowledge|call_tool|handoff|no_action|wait|end_session|schedule_send）",
  "no_action_reason（next_action 为 no_action 时必填：message_not_actionable|waiting_for_user|duplicate_event|handoff_active|agent_disabled|superseded|policy_suppressed|noise|listening）",
  "requires_human（布尔值）",
  "risk_level（low|medium|high）",
  "handoff_briefing（可选，转人工时提供 {problem_summary, unresolved_items, suggested_first_reply}）",
  "knowledge_query（retrieve_knowledge 时必填）",
  "tool（call_tool 时提供 {name, arguments}，arguments 仅包含字符串值）",
  "wait_ms（wait 时必填，30000~900000 毫秒）",
  "nudge_text（wait 时可选，等待超时后由系统代发的提醒话术）",
  "scheduled_message（schedule_send 时必填，到点直发的完整文本，≤2000 字）",
  "scheduled_send_at（schedule_send 时必填，ISO 8601 本地时间，未来 1 分钟~30 天内）",
  "closure_summary（end_session 时必填，本次会话片段的收尾摘要）",
];

/**
 * 生成"只输出以下字段"提示词句子。
 * 用于平台兜底系统提示词；Solution Strategy 可拼接自己的扩展字段。
 */
export function decisionFieldContractText(): string {
  return `只输出以下字段（未列出的字段一律不输出）：\n  ${DECISION_FIELD_CONTRACT.join("、")}`;
}
