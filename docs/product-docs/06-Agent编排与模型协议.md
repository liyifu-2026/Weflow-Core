# 06 · Agent 编排与模型协议

> 出处：`core/modules/agent/application/*`、`CONTEXT.md`「Agent 能力面与工具扩展标准」
> 「模型协议」「群聊对话线程与降噪」「私聊回合制增强」、`docs/plans/THINKING-PIPELINE-PLAN.md`。

## 1. 能力面三分法（判断标准只有一条：这个东西是谁发起的）

| 类别 | 内容 | 设计理由 |
|------|------|----------|
| **一、系统喂的**（被动，模型开口前自动发生） | 语音 ASR 转写、图片 vision 描述、记忆召回（12 条确认记忆）、客户档案基础信息 | 几乎每轮都需要（可选会漏看）、是构建上下文的前置步骤、自动一次成本远低于模型反复决定 |
| **二、模型要的**（信息工具，沙箱级只读） | query_contact_profile / retrieve_knowledge / fetch_url / search_chat_history | 白名单、超时、预算管控 |
| **三、模型做的**（决策动作，事务级，每轮必选其一） | reply / ask_for_information / handoff / no_action / wait / end_session / schedule_send / retrieve_knowledge / call_tool | 契约强制显式决策——「什么都不干」也必须带原因申报，每一轮都有可审计结局 |

分工哲学：**系统喂的追求确定；模型要的走沙箱；模型做的要硬化**（事务/状态机/护栏）。
勿把发微信、转人工降级成普通工具，也勿给只读工具加事务负担。

## 2. 回合（Turn）状态机与准入

```
消息入站 → turn_admission_states 合并窗口（基准 12s；「半句启发式」判定话没说完则延长至 30s：
以 。！？!?…～~ 结尾=说完用基准窗；以逗号/顿号/分号/冒号等非终止标点或「但是/然后/那个/等我/
还有…」等口语拖词结尾=没说完用延长窗。实现 `turn-admission.ts` 的
UNFINISHED_TAIL_RE / UNFINISHED_PUNCT_RE / FINISHED_TAIL_RE 三个正则）
        → dispatcher 到期 CAS 认领 → 建 1 个 Agent Turn（trigger_message_id 唯一）

queued → running ⇄ tool_planned（工具检查点，等工具执行后续步恢复）
终态：completed | failed | superseded(absorbed_into:<turnId>) | suppressed_policy | suppressed_handoff
```

- 合并只针对**排队** Turn，运行中模型请求绝不取消。
- 工具租约 5 分钟：过期 stale 的只读工具回 `planned` 重领；已成功工具结果直接复用。
- Turn 执行时绑定当时的 Execution Profile（策略与技能集），排队/运行中不随配置变更切换。
- **同会话串行、跨会话并行**（`AGENT_WORKER_CONCURRENCY`=3 全局并发）。
- 前一批回复 pending/submitting/unknown 时，不处理该会话下一个 Turn。

## 3. 一轮的时间线（示例）

客户发破损照片 + 语音「你看看这东西」：

```
系统喂：ASR 转写（SILK→MP3→文本）＋ vision 描述（图片→文字）
     ＋ 建轮（合并窗收口）＋ 记忆召回 12 条 ＋ 事实卡注入
模型要：retrieve_knowledge("产品破损 退换政策") → 工具检查点 → WeKnora 检索 → 证据回喂
模型做：reply（≤8 段回复 + wait_ms 交权）
系统执：策略闸门 → 重复指纹拦截 → send operations 逐段发出（打字节拍）
     → 「说话并等待」：wait 到期自唤醒（session wake）
```

## 4. 工具目录（`tool-catalog.ts`，4 个，全只读）

| 工具 | 参数 | 超时 | 用途 |
|------|------|------|------|
| `query_contact_profile` | 无 | 2s | 查当前客户档案（联系方式/备注/标签） |
| `retrieve_knowledge` | query(1–1000 字) | 15s | 检索知识库；故障/报错/政策类问题必须先检索，无证据不得编造 |
| `fetch_url` | url(≤2000) | 15s | 抓取客户提供链接正文 |
| `search_chat_history` | scope(speaker\|group)、speaker、keyword、before_hours(1–720)、limit(1–20) | 5s | 检索本群历史文本消息（仅群聊下发）；与 retrieve_knowledge 共享 4 步预算 |

**扩展标准**：新增工具只需改 tool-catalog + executeToolPlan 实现 + 提示词，无需动决策契约。
现状不引入 MCP（无真实需求不建协议基建）；触发条件 = 出现真实的外部系统查询需求
（订单/物流/会员积分），届时单一内部查询走现有契约直改、批量/第三方走 MCP 客户端化。

## 5. 决策协议与处置管线（`decision-disposition.ts`）

**9 个决策动作**：`reply / ask_for_information / retrieve_knowledge / call_tool / handoff /
no_action / wait / end_session / schedule_send`（最后一个受联系人级开关控制、缺省关闭；
业务策略提示词暴露 8 值子集——分层设计而非漂移）。

**no_action 原因码 10 值**：`message_not_actionable / waiting_for_user / duplicate_event /
handoff_active / agent_disabled / superseded / policy_suppressed / noise / listening / session_closed`
（平台提示词面仅列前 9 个，`session_closed` 由系统在 end_session 无收尾话术等场景自申报；
注意**业务策略插件的提示词散文是另一套 8 值口径**——含 Core 契约没有的 `planner_corrected`、
不含 `noise/listening`，两套枚举在解析层映射收敛，见 08 章 §3）。

**14 字段决策契约**（提示词权威顺序）：reply_segments（≤8 段、每段 ≤500 字）、next_action、
no_action_reason、requires_human、risk_level、handoff_briefing、knowledge_query、
tool{name,arguments}、wait_ms（30s–15min）、nudge_text、scheduled_message（≤2000 字）、
scheduled_send_at（未来 1min–30 天）、closure_summary、facts_card。
**完整决策 JSON 示例见 05 章 §14。**

**处置尾迹顺序**（fresh 与 tool_recovery 双路径共享，防漂移）：

```
事实卡落库（失败静默）
→ 策略闸门（requiresHuman‖high‖handoff ⇒ 强制 handoff；告别语复读守卫逐段剔除）
→ no_action → schedule_send → wait（落唤醒计划）→ end_session（可选收尾话术，关 session/群线程）
→ 回复分段校验（硬闸）→ 整批复读判定（指纹）→ 工具检查点（≤2 条过程短讯软闸）
→ 真 ReAct 续步（reply/ask 不带 wait_ms = 回合没干完）
   预算：决策步 8 步（按 model_call 计数）+ 续步批 2；群聊永不续步；triage 直答档关闭续步
→ 终态落库 ＋「说话并等待」
```

**预算口径辨析**（四组数字的关系）：`agent.execution_profiles` 表记录的
`max_model_calls=2 / max_tool_calls=1 / timeout_seconds=60` 是 Profile 的**声明字段**
（缺省值，随 profile 绑定落库）；**当前运行时真正生效的预算**是本节的三项——
决策步预算 8（按 `model_call` 事件计数）、续步批预算 2、工具共享 4 步预算
（与设置中心「ReAct/工具步预算 toolStepBudget=4」是同一项，retrieve_knowledge 与
search_chat_history 等工具共享）。冲突时以运行时预算为准。

**吸收式回合（客户插话）**：回合运行中客户补充消息 → 排队新轮标记
`superseded(absorbed_into:<当前turnId>)`，事件 `turn_absorbed_input`；当前回合继续。
**三分裁决矩阵 `absorbVerdictFor`（承重，测试逐格钉住）**：

| 裁决 | 条件 | 动作 |
|------|------|------|
| carry-through | 查证/定时/收线意图（retrieve_knowledge / call_tool / end_session / schedule_send） | 照常走分支（对新上下文仍有效） |
| commit-as-step | 仅 tool_recovery 且 reply/ask 有分段（工具结论只活在恢复决策提示词里，丢弃即永久丢失） | 先把回复以 step 落库再继续 |
| discard | 其余过时生命周期决策（fresh 的 reply/ask/no_action/wait） | 作废不落库，下一轮在含插话的新鲜上下文上重决策 |

回合边界 = 机器人自主收口（wait 交权 / end_session / 预算耗尽）；插话是回合内部事件而非边界。

## 6. 三层记忆与上下文

| 层 | 载体 | 窗口 | 作用 |
|----|------|------|------|
| 会话事实卡 | `agent.fact_cards`（每会话一行 JSONB） | 跨天 | 当前问题/已确认事实/已尝试方案/未兑现承诺/待确认问题；模型随决策 `facts_card` 全量更新（sanitize 收敛），下回合开头注入 `【会话事实卡】` |
| 轮窗 | `agent.turns` + reply_batch_id 精确重建 | 本 episode 原文 20 条 + 摘要行（≤4 行、72h） | 20 条外的更早回合压成「MM-DD HH:mm 客户：…｜客服：…」摘要行，不在回合中间腰斩 |
| 长期记忆 | `memory.memories`（12 条召回） | 跨月 | 客户档案级事实/偏好/关系；90s 安静窗口后提取；敏感/不稳定/非明确不进召回 |

上下文可信度分层（`core/AGENTS.md`）：可信工具事实 / 人工确认档案 / 用户陈述 / 确认记忆 /
知识证据 / 视觉观察 / 模型推断——**推断不得未受控升级为确认事实**；图片描述是观察不是确定，
不得用占位符回复图片。

## 7. 群聊 vs 私聊（同一管线，chatType 分支）

**群聊（话题制）**：
- **准入模式四选一**（设置中心「安全 → 群聊策略」，存 `groupChat` 键；按群 override 可覆盖）：

| 模式 | 语义 |
|------|------|
| `mention_only` | 只有 @ 机器人（botNames 文本匹配）才建轮——**部署种子默认** |
| `mention_or_keyword` | @ 命中**或**消息命中配置的响应关键词都建轮 |
| `accept_all` | 全部群消息按 `probability` 随机概率建轮（配合冷却护栏） |
| `off` | 群聊完全不建轮 |

- 触发细节：@ 判定优先按配置 `botNames` 文本匹配（`text.includes("@<昵称>)"`；Host 的
  `mentioned` 是 fail-open 不作唯一依据），botNames 为空才回落 Host 判定（ADR-0011 引擎缺省
  `[]` 中立，部署种子写 `["客服"]`）；`extraInstruction` 群聊附加指令注入提示词。
- **冷却护栏**：`cooldownMinutes` 窗口内最多 `maxReplies`（默认 2）次回复，防止刷屏。
- 线程：@ 命中开线（`session:group-thread:` 前缀 agent_sessions 行）；存活期内任何群成员消息免 @ 建轮
  （开放地板）；`end_session` 自主收线或 TTL（缺省 15 分钟，0=无线程）+ 轮数 + 冷却兜底。
- 降噪：`isGroupNoiseText` 在**闸门处**不建轮（线程开着也不建、不烧模型）；上下文窗口内噪声出原文、
  按发送者计数进摘要行（「近段群内另有：小白 ×5」）；**最新一条入站永不过滤**。
- 群历史筛选：`search_chat_history` 工具；群聊回复不进续步循环（一次说完）。
- 群记忆（三闸 + scope 隔离）后置：启动条件 = 群进入真实运营。

**私聊（回合制）**：吸收式回合 + 三层记忆（§5/§6）；`agentEnabled=false` 仅人工
（无回复、无记忆捕获）；`blocked=true` 拉黑（不建轮、不进列表、不推通知，消息照常入库）。

## 8. Handoff 状态机

**状态集与转移矩阵**（会话当前权威行 `handoff.states`；每次接管一个 `handoff_cycles` 行）：

```
                 create（模型 handoff / 人工发起）
  （无 Handoff）──────────────▶ pending（待认领）
                                   │  accept / take-over
                                   ▼
                              in_progress ─── transfer(user) ──▶ transfer_pending
                                   │                                 │ accept→in_progress
                                   │                                 │ 或 reject/15min 超时
                                   │ transfer(queue)                 ▼
                                   ├────────────────────────▶ pending（指向兜底/通用队列，
                                   │                            等成员接手；见下 reject 行）
                                   │  resolve
                                   ▼
                               resolved ── finish ──▶ finished
```

| 操作 | 起态 → 终态 | 说明 |
|------|------------|------|
| create | 无 → pending | 取消 pending Agent 草稿 + 程序控制确认话术；agent_paused=true |
| accept / take-over | pending / transfer_pending → in_progress | 原子认领（expectedHandoffRevision）；take-over 可从 Agent 会话直接接管；409 竞争失败是正常结果 |
| transfer(user) | in_progress → transfer_pending | 转给指定客服，等待接受；`accept_by` = 15 分钟 |
| transfer(queue) | in_progress → **pending** | 释放进专业队列（新建 pending cycle 指向队列），等成员接手 |
| reject-transfer | transfer_pending → **pending** | 目标拒绝：原 cycle 置 `finished(result=transferred)`，**新建 pending cycle 指向兜底队列**（`fallback_queue_id`，无则通用队列），assignee 清空——**不回原处理人** |
| release | in_progress → pending | 释放回待认领 |
| resolve | in_progress → resolved | 生成解决摘要作业（3 次尝试） |
| finish | resolved → finished | 收尾完成；cycle 终止 |
| 超时兜底 | transfer_pending → pending(fallback) | **转给指定人** 15 分钟未接受：维护任务（actor=system）走与 reject 相同的回落路径（`moveDirectTransferToFallback`）；**转给队列**不设 accept_by |

解决摘要作业：resolve 时写入 `handoff.resolution_summary_jobs`（3 次尝试），由 **api 进程的
mobile handoff maintenance 常驻任务**消费（`processResolutionSummaryJobs`），摘要回写
`cycles.resolution_summary`。

- **归属锁**：`pg_advisory_xact_lock(hashtext("weflow:ownership:<conversationId>"))`——
  人工接管与 Agent 出站落库竞争同一把锁，结构性杜绝「人在处理时 AI 还外发」的双发窗口；
  取锁后重读 agent_paused / handoff status 才权威。
- 建 Handoff：取消 pending Agent 草稿、发**程序控制**确认话术（不允许模型自由发挥高风险话术）、
  在途模型结果被抑制（`suppressed_handoff`）；解决 Handoff 不重放旧草稿。
- Handoff 语义：暂停该会话的新 Turn/Case 变更/自动工具/自动出站（其他会话不受影响）。
- 提醒：pending 超 120s（`handoffReminderDelayMs`）且配置了话术 → 系统代发轻提示（缺省空=关闭）。
- 超时兜底：转交队列无人认领 → `accept_by`/`fallback_queue_id` 回落兜底队列（常驻维护）。
- 操作全部幂等（clientRequestId + request_hash + response_snapshot 重放）。

## 9. 媒体管道全流程

```
入站登记（ingest，media_assets status=queued）
→ 同步下载（api 轮询，CAS 领取，responseBodyStream 落盘）
   ├─ 图片/语音 → processing_queued（入 BullMQ media-processing）
   └─ 文件/视频 → 直接 ready（无派生阶段）
→ ingestion-worker：
   图片描述（方向守卫：非 inbound 终态化不建 Turn；>10MB 回退缩略图；vision 模型）
   语音转写（SILK→MP3 转码 derived_file_id；ASR 双协议 chat_inline|audio_transcriptions）
→ 原图升级（thumbnail 来源的图片后台拉全尺寸；已有描述保留避免双倍视觉成本）
→ 卡死回收：多模态阶段停滞 15 分钟视为卡死（recoverStaleMedia）
→ 完成发布 conversation_updated 事件（前端无感刷新转写/描述）
→ 图片描述完成后若仍 inbound 且未 Handoff → 可补建 Agent Turn（AI 看到"客户发图"后作答）
```

Handoff 中的入站媒体转人工处理（`route-media-to-human.ts`）。
上传侧只拦可执行文件与脚本（黑名单，`upload_type_blocked`→415），不做格式白名单。

## 10. Triage 预判分流

Agent Turn 进主决策前，极速小模型（TRIAGE_*，默认 Qwen2.5-7B，3s 超时）做
「人工/自动 × 简单/标准」分流：simple 档可走 FAST 直答模型（15s 超时，不进续步循环）。
system prompt 由设置 `pipeline.triage.systemPrompt` 下发（ADR-0011）；未配置时 LLM 层
**fail-open 放行**（规则层 riskKeywords 照常生效）。

## 11. 模型协议（2026-09-05/06 实测）

- 端点与型号：`MODEL_BASE_URL`（现 = DeepSeek 官方 `api.deepseek.com`）、`MODEL_NAME`
  （现 = `deepseek-v4-flash`，混合思考型）。运行期唯一事实源是 DB 模型注册表
  （设置中心「模型」页热改，五槽位 + 故障转移链）。**故障转移语义**：模型调用抛出任意错误
  （网络/超时/HTTP 错误态）即沿 `failover_to` 链切到下一个模型重试，直到链耗尽
  （报 `failover_chain_empty` / `failover_chain_exhausted`）；链由解析层展开并防环。
- **思考控制**：请求体 `thinking: {type: "enabled"|"disabled"}`——探针证实 DeepSeek 尊重该字段。
  structured（JSON 决策）默认开、text 默认关；请求级可覆盖。
- **预算**：`max_tokens` 含思维链，默认 16384；`finish_reason=length` → `model_output_truncated`
  → 降上下文（系统提示 + 最近 4 条）重试一次 → 仍截断转人工。**绝不把截断 JSON 喂给解析器**。
- **超时**：普通 60s（`MODEL_TIMEOUT_MS`）；决策 180s（`MODEL_DECISION_TIMEOUT_MS`）。
  流式改造后置（触发条件：180s 下仍频繁超时）。
- **可观测**：每次决策调用落 `model_call` 事件（usage/latencyMs/finishReason）；思维链落
  `model_reasoning` 事件（≤8k 字符，草稿纸不进审计事实）；fresh 与 tool_recovery 两路径均记录。
- **实测数据**（B0 探针，2026-09-05）：模型调用本身 87–246ms；轮次 10–24s 延迟大头在
  管线排队与通道，不在模型。thinking 参数全形态 finish=stop，截断守卫为防御性。
- **FC 迁移（悬留优化项）**：原生 function calling 探针 6/6 通过（2026-09-06）——
  DeepSeek 原生 FC 与 thinking 正交。迁移要点：client 加 tools/tool role 透传 → 决策协议双轨 →
  解析器换 tool_calls → 提示词去 JSON 条款（循环/落库/护栏/预算不动）。
  硬约束：assistant 每个 tool_call 必须有对应 tool 消息回喂（缺一 400）；json_object 需提示词含 "json"。
  现状：代码已具备 `TextToolDefinition` 协议与 model-client-fc 测试，业务策略仍走 JSON 决策协议。

## 12. 行为设置（热生效，`behavior` 键）

设置中心「AI 员工 → 行为参数」（agent-worker 30s TTL 缓存热读）：会话 TTL（默认 45 分钟）、
会话轮数上限（24）、**wait 缺省时长**（`defaultWaitMs` 默认 300_000ms——**wait 动作**未带
wait_ms 时的回退值，**不是上限**；wait 合法域由决策协议钳制为 30s–900s）、nudge 话术、
handoff 提醒话术、handoff 提醒延迟（120s）、ReAct/工具步预算（toolStepBudget=4）。

**两个「缺省 wait」不要混淆**（作用于不同位置）：
- `behavior.defaultWaitMs`（设置可改，默认 300s）：模型输出 **`wait` 动作**但未带 wait_ms 时，
  Core 处置层用它落唤醒计划（`decision.waitMs ?? defaultWaitMs`）。
- 插件常量 `DEFAULT_REPLY_WAIT_MS = 90s`：**reply/ask 动作**未带 wait_ms 时，策略插件在解析层
  补的「说完交权」默认值；可被设置 `pacing.defaultReplyWaitMs` 覆盖（未配置=90s；显式 null/≤0
  = 关闭该缺省，回到引擎「无 wait 即续步」语义）。

## 13. 全局开关（runtime-settings，7 个）

存 `operations.runtime_settings`（DB key ↔ 字段映射见下），**出厂全开、合并窗口除外**；
PATCH 修改写审计（previous/next + operationId 分组）并支持回滚。其中 **Kill Switch（AI 自动
应答）关闭后新消息不再触发 AI 回复**——瞬时暂停，不影响人工操作与已入队 Turn 落库；被拦截的
发送置 `held` 终态，**恢复开关后不自动补发**。模型槽位选择不在此处（唯一事实源是模型注册表）。

| 中文语义（设置中心） | 字段 / DB key | 出厂值 |
|----------------------|---------------|--------|
| AI 自动应答（Kill Switch） | `agentEnabled` / `agent_enabled` | **true** |
| 自动发送 | `autoSendEnabled` / `auto_send_enabled` | true |
| 合并窗口 | `mergeWindowEnabled` / `merge_window_enabled` | **false** |
| 发送期插话闸门 | `outboundInterjectGateEnabled` / `outbound_interject_gate_enabled` | true |
| 知识检索 | `knowledgeEnabled` / `knowledge_enabled` | true |
| 长期记忆 | `memoryEnabled` / `memory_enabled` | true |
| 图像理解 | `visionEnabled` / `vision_enabled` | true |

模型槽位选择不在此处（text/vision/asr 槽位唯一事实源是模型注册表，见 12 章 §3）。
