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
  "session_closed",
] as const;

/**
 * 单批回复的段数硬上限（zod schema 与出站校验同源于此）。
 * 这只是防滥用的天花板，不是目标段数：真人拆条节奏由提示词按内容
 * 自行判断（简单问题 1 条，排查步骤可拆多条），提示词文案不写死
 * 数字区间，避免模型锚定上限输出固定段数。
 */
export const MAX_REPLY_SEGMENTS = 8;

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
  "reply_segments（可选：把回复像真人聊天那样按动作拆成一条条短消息，每条只说一件事，简单问题 1 条即可，多步说明可拆多条，条数按内容自定，不要固定段数；或旧字段 reply_text。call_tool/retrieve_knowledge 也可选附带 ≤2 条过程性短讯——系统会在执行工具前先发给对方）",
  "next_action（reply|ask_for_information|retrieve_knowledge|call_tool|handoff|no_action|wait|end_session|schedule_send）",
  "no_action_reason（next_action 为 no_action 时必填：message_not_actionable|waiting_for_user|duplicate_event|handoff_active|agent_disabled|superseded|policy_suppressed|noise|listening）",
  "requires_human（布尔值）",
  "risk_level（low|medium|high）",
  "handoff_briefing（转人工时提供 {problem_summary, unresolved_items, suggested_first_reply}；handoff 可同时提供 reply_segments 作为转接前发给对方的简短告别话术，措辞遵循接入方策略，缺省则转人工不发言）",
  "knowledge_query（retrieve_knowledge 时必填；系统会真实执行检索并把结果回喂给你，届时再给最终回复，本条不得提前编写结论）",
  "tool（call_tool 时提供 {name, arguments}，arguments 仅包含字符串值）",
  "wait_ms（wait 时必填，30000~900000 毫秒；reply/ask_for_information 可选携带，是「继续 vs 交权」开关：不带=本回合还没干完，系统立即进入下一步决策；带=发完挂等待计时器，到期对方未回复则唤醒续轮）",
  "nudge_text（wait 时可选，等待超时后由系统代发的提醒话术）",
  "scheduled_message（schedule_send 时必填，到点直发的完整文本，≤2000 字）",
  "scheduled_send_at（schedule_send 时必填，ISO 8601 本地时间，未来 1 分钟~30 天内）",
  "closure_summary（end_session 时必填，本次会话片段的收尾摘要）",
  "facts_card（可选：会话事实卡的最新完整内容 {problem, confirmed_facts[], attempted[], promises[], open_questions[]}——系统每回合开头提供当前卡，有变化时随决策返回更新；无变化可省略）",
];

/**
 * 生成"只输出以下字段"提示词句子。
 * 用于平台兜底系统提示词；Solution Strategy 可拼接自己的扩展字段。
 */
export function decisionFieldContractText(): string {
  return `只输出以下字段（未列出的字段一律不输出）：\n  ${DECISION_FIELD_CONTRACT.join("、")}`;
}
