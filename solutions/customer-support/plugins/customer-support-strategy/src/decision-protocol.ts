/**
 * 决策协议（Decision Protocol）单一事实源。
 *
 * 模型决策协议的全部机制散文集中在此：next_action 动作枚举、wait_ms 合法域、
 * 沙箱工具名清单，以及内置路径与 AI 员工路径共享/平行的提示词协议块。
 * parser.ts 的动作分支与本文件的 NEXT_ACTION_VALUES 一一对应——新增动作时
 * 改这一个文件（+parser 加一个 case），两条提示词路径的散文自动同步。
 *
 * 硬约束：本文件的渲染输出由 tests/prompt.test.ts 对 tests/goldens/prompts.json
 * 做字节级快照，改动散文必须先确认是协议变更而非笔误。
 */

// ---------- 常量原子（parser 与提示词共享） ----------

/** 模型可输出的 next_action 全集（与 parser.ts 的 switch 一一对应） */
export const NEXT_ACTION_VALUES = [
  "reply",
  "ask_for_information",
  "retrieve_knowledge",
  "call_tool",
  "handoff",
  "no_action",
  "wait",
  "end_session",
] as const;

/** 提示词里的枚举散文（字段说明/输出格式段共享） */
export const NEXT_ACTIONS = NEXT_ACTION_VALUES.join("|");

/**
 * wait_ms 合法域（与平台 WAIT_MS_RANGE 对齐）；模型漏给时回落 fallback。
 * rangeProse 是 clamp 范围的提示词散文；firstRangeProse 是首次等待的节拍
 * 引导（软规则，只出现在提示词里，parser 不 clamp 它）。
 */
export const WAIT_MS = {
  min: 30_000,
  max: 15 * 60_000,
  fallback: 60_000,
  rangeProse: "30000~900000",
  firstRangeProse: "首次 60000~120000",
} as const;

/**
 * reply / ask_for_information 未带 wait_ms 时的业务默认等待。
 *
 * 引擎语义是「不带 wait_ms = 本回合还没干完，系统立刻让你继续」；客服场景
 * 这条默认恰恰是反的——排查步骤必须等客户反馈才能走下一步，模型一漏填
 * wait_ms 就会续步把同一步骤换个说法再发一遍。所以业务层把缺省补齐为
 * 「说完交权」，引擎机制不动。取值落在 firstRangeProse 区间内。
 * null（或 ≤0）= 沿用引擎语义，仅在需要「连续多步」的场合显式关闭。
 */
export const DEFAULT_REPLY_WAIT_MS = 90_000;

/** call_tool 的 name 合法域（沙箱级信息工具全集） */
export const TOOL_NAMES_PROSE =
  "query_contact_profile|retrieve_knowledge|fetch_url|search_chat_history";

/** 知识可用性提示句（两条路径共用，前缀不同：内置路径内联、AI 员工路径带换行） */
export function knowledgeSentence(
  knowledgeAvailable: boolean,
  prefix: string,
): string {
  return knowledgeAvailable
    ? `${prefix}知识库检索当前可用，证据不足时先向客户询问必要信息，不要编造答案。`
    : `${prefix}知识库检索当前不可用，不得选择 retrieve_knowledge。`;
}

/**
 * 对话约束（两条路径共用业务策略，不含机制说明与措辞风格；前缀同
 * knowledgeSentence：内置路径内联、AI 员工路径带换行）。
 *
 * 这三条是实测事故的直接对治：AI 员工路径此前只拼机制散文（节拍/输出格式），
 * 拿不到「一步一等反馈」「不复读」「不编造系统行为」，于是出现过同一步骤连着
 * 发多条、被客户追问时回一句「系统重发了」的情况。
 */
export function dialogueConstraints(prefix: string): string {
  return `${prefix}【对话约束】每条只说一件事（一个结论、要一个信息、或一步操作）；排查类问题按当前步骤逐条发送，下一步必须等客户反馈后再发，不要在同一回合里把后续步骤连着倒出来。不得逐字重复你上一条已发送的回复；客户重复追问同一问题时，用不同措辞简短确认或补充新信息。不得向客户解释或猜测系统内部行为（是否重发、排队、限流、超时、截断）；客户指出收到重复或异常消息时，简短承认后直接给下一步，不猜测原因。`;
}

// ---------- 内置路径（customerSupportSystemPrompt）的协议块 ----------

export function builtinChatTypeRules(chatType: "private" | "group"): string {
  return chatType === "group"
    ? `当前为群聊场景：回复必须简洁（通常不超过 2-3 句），避免长篇大论；不得包含私人信息、订单详情或针对特定联系人的个性化内容；如果问题涉及个人隐私信息，建议对方私聊咨询。
群聊节拍：可以用 reply_segments 像真人打字那样拆成 2-3 条短消息（按打字节奏逐条发出），但 reply 批只有这一次，不会再有补充批；说完若要等群里回应，附带 wait_ms（${WAIT_MS.firstRangeProse}）——期间有人发言会自动打断等待并作为新消息处理，到点无人接话会唤醒你，轻追问一次（时长加倍）或用 end_session 安静收尾，连续唤醒 2 次必须收尾。需要查证时用工具（结果回喂），查完再给最终回复。多人发言拿不准时，可用 search_chat_history 查某人的历史发言（scope=speaker 配 speaker）或群里某段时间的消息（scope=group），可加 keyword 和 before_hours——不要凭模糊印象转述他人原话。`
    : "当前为私聊场景：可使用知识库检索、工具调用等完整能力；像真人工程师一样逐步推进排查，一次不要灌大段内容。";
}

export function builtinPacingRules(): string {
  return `对话节拍（重要）：
- 回合内你可以连续多步工作：说一句、调用工具、等系统把结果喂回、再说下一句，直到把事情办完。你输出的 retrieve_knowledge / call_tool 会被系统真实执行，结果在下一步回喂给你；届时再基于结果给最终结论，本条 JSON 里不得提前编写结论或声称已查询。
- reply/ask_for_information 带不带 wait_ms 是「继续 vs 交权」的开关：不带 = 本回合还没干完，系统会立刻让你进行下一步决策；带（${WAIT_MS.firstRangeProse}）= 说完等对方回应，回合结束。对方随时可能回复，会自动打断等待，不必担心错过。
- 需要动手查证时，在同一 JSON 里先给过程性短讯再发工具动作，例如 {"next_action":"retrieve_knowledge","knowledge_query":"导出失败 排查","reply_segments":["稍等，我看下后台。"]}——系统会先把短讯发给对方，再执行检索。
- 若上下文标注"本Turn由等待超时唤醒"（对方在你上次回复后一直没说话）：不要重复已说过的内容；仅在问题确实没解决且值得追问时，发一条简短的轻量追问并再次 wait（wait_ms 加倍）；否则选择 end_session 收尾。连续唤醒 2 次后必须 end_session。
- 对方明确表示结束（如"好的谢谢""明白了"）、寒暄类无需跟进的消息：直接 end_session（可选带一句简短收尾话术）。
- wait 单独使用表示本轮不说话纯等待（例如对方说"稍等我去试试"）；end_session 提供 closure_summary（内部收尾摘要，不发给对方），可另附 reply_segments 作为发给对方的收尾话术。`;
}

export function builtinOutputFormatRules(): string {
  // 视觉模型在长字段段落里偶发丢 next_action 键（实测 19:33 场景整轮静默）：
  // 用一行硬性示例把必填键钉在字段说明之前。
  return `输出格式（硬性要求）：每次只输出一个 JSON 对象，必须包含 next_action 键（${NEXT_ACTIONS}），例如 {"next_action":"reply","reply_segments":["我看下。"],"wait_ms":80000}；缺 next_action 的输出会被直接丢弃，客户收不到任何回复。上下文开头会提供【会话事实卡】（跨回合持久的会话状态）；有变化时用 facts_card 字段返回更新后的完整卡片。`;
}

export function builtinFieldSpec(knowledgeAvailable: boolean): string {
  return `字段：next_action（${NEXT_ACTIONS}）、no_action_reason（next_action 为 no_action 时必填：message_not_actionable|waiting_for_user|duplicate_event|handoff_active|agent_disabled|superseded|policy_suppressed|planner_corrected）、requires_human（布尔值）、risk_level（low|medium|high)，以及按动作条件提供字段。reply/ask_for_information 时提供 reply_segments：像真人在聊天窗口逐条打字那样把回复拆成短消息，每条只说一件事（一个结论、要一个信息、或一步操作）；简单问题一条说清即可，排查类问题按当前步骤逐条发送，下一步等客户反馈后再发；不要固定段数、不要"总-分-总"排版、也不要把全部内容挤进一条长消息（或旧字段 reply_text，整段单条）；不带 wait_ms 表示本回合还要继续工作（系统会立刻让你进行下一步决策，通常是调用工具查证），带 wait_ms 表示说完交权等对方；可选 nudge_text（到点对方仍未回复时代发的一句轻提醒）。retrieve_knowledge 时提供 knowledge_query——系统会真实执行检索并把结果回喂给你，届时再给最终回复，本条 JSON 不得提前编写结论或声称已查询；可同时附 reply_segments（≤2 条过程性短讯，如"稍等，我看下后台。"，系统会在执行前先发给对方）。call_tool 时提供 tool：{name: ${TOOL_NAMES_PROSE}, arguments: 仅包含字符串值的对象}，同样可附 reply_segments 过程短讯。handoff 时提供 handoff_briefing：{problem_summary: 对当前问题的简短事实摘要, unresolved_items: 尚未解决事项数组, suggested_first_reply: 人工接手后可编辑的建议首句}，并同时提供 reply_segments 作为转接前发给客户的最后一句自然话术（1~2 条，按【语气】规范说，如"这个我帮你转同事看一下，稍等。"；不要声称客服已在线、不要承诺响应时限、不要向客户复述转人工的内部原因）；wait 时提供 wait_ms（${WAIT_MS.rangeProse} 毫秒）；end_session 时提供 closure_summary（本次会话收尾摘要，内部记录不发给对方），可选 reply_segments（发给对方的收尾话术，先发送再结束）。建议首句不得声称已经完成尚未执行的操作。facts_card（可选）：会话事实卡的最新完整内容 {problem, confirmed_facts[], attempted[], promises[], open_questions[]}——上下文开头会给当前卡，有变化时随决策返回更新，无变化省略。${knowledgeSentence(knowledgeAvailable, "")}`;
}

// ---------- AI 员工路径（aiEmployeeSystemPrompt）的协议块 ----------
// 平台注入块只讲机制（JSON 契约、回合节奏、工具语义、能力可用性），不得
// 夹带标点/句式等风格规则或带风格倾向的示例——否则示例锚点会压过人设
// （v3「句末不加句号」曾被旧【语气】块的「用句号结尾」对冲失效）。

export function aiChatTypeRules(chatType: "private" | "group"): string {
  return chatType === "group"
    ? `

【群聊场景约束】回复必须简洁（通常不超过 2-3 句），避免长篇大论；不得包含私人信息、订单详情或针对特定联系人的个性化内容；如果问题涉及个人隐私信息，建议对方私聊咨询。
【群聊节拍】可以用 reply_segments 拆成 2-3 条短消息（按打字节奏逐条发出），但 reply 批只有这一次，不会再有补充批；说完若要等群里回应，附带 wait_ms（${WAIT_MS.firstRangeProse}）——期间有人发言会自动打断等待并作为新消息处理，到点无人接话会唤醒你，轻追问一次（时长加倍）或用 end_session 安静收尾，连续唤醒 2 次必须收尾。需要查证时用 retrieve_knowledge/call_tool（结果会回喂），查完再给最终回复；多人发言拿不准时，可用 call_tool 调 search_chat_history（参数 scope=speaker/group、speaker、keyword、before_hours、limit）查某人历史发言或群里某段时间的消息——不要凭模糊印象转述他人原话。`
    : "";
}

export function aiPacingHint(chatType: "private" | "group"): string {
  // 私聊拼对话节拍（回合机制说明，不含措辞风格）；群聊不发 wait 计时器。
  return chatType === "private"
    ? `

【对话节拍】回合内可连续多步工作：说一句、调用工具（retrieve_knowledge/call_tool 会被系统真实执行并把结果回喂给你，届时再给最终结论，本条 JSON 不得提前编造结论）、再说下一句。reply/ask_for_information 带不带 wait_ms 是「继续 vs 交权」开关：不带 = 本回合还没干完，系统立刻让你进行下一步决策；带（${WAIT_MS.firstRangeProse}）= 说完等对方，回合结束（对方回复会自动打断等待）。查证前可在同一 JSON 附 reply_segments（≤2 条过程性短讯，措辞遵循你的人设，系统会先发给对方再执行）。若上下文标注等待超时唤醒（对方一直没回复）：不重复已说内容，确有必要才发一条简短追问并再次 wait（时长加倍），连续唤醒 2 次后选择 end_session（closure_summary 为内部摘要；可选 reply_segments 作为发给对方的收尾话术）。对方明确结束或寒暄无需跟进时直接 end_session。wait 单独使用表示本轮不说话纯等待。需要转人工时（handoff）：同时给 reply_segments 作为转接前最后一句自然话术（措辞遵循你的人设），不声称客服已在线、不承诺响应时限。`
    : "";
}

export function aiOutputFormatHint(): string {
  // 输出契约对两种会话类型都必须在场：AI 员工人设路径原本没有字段 schema，
  // 模型只从节拍提示里零散抄字段名，曾实测丢掉 next_action 整轮静默。
  return `

【输出格式】每次只输出一个 JSON 对象，必须包含 next_action 键（${NEXT_ACTIONS}），例如 {"next_action":"reply","reply_segments":["我在看"],"wait_ms":80000}；缺 next_action 的输出会被直接丢弃，客户收不到任何回复。`;
}
