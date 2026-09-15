# Weflow Core

Weflow Core（原 CocoCat Server2）是 Weflow 的平台业务核心。Core 通过 Channel Host 通用协议接入任意消息通道，承载多用户协作、对话编排、知识检索、长期记忆和 Agent 执行；业务能力通过 Execution Strategy / Skill 插件扩展，不内置具体业务策略。

## Language

### 系统角色

**Channel Host**:  
运行任一消息通道并实现 Core 通用 HTTP 协议（HttpChannelProvider/httpChannelPlugin）的通道运行单元，负责登录、感知入站事件、执行消息发送及通道专有媒体处理。  
_Avoid_: Agent、业务后端、Core 内部模块

**Core**:  
Weflow 的无界面业务核心，拥有除通道原始事实之外的全部业务事实；Agent 流程由 Execution Strategy 与 Skill 插件驱动。  
_Avoid_: 客户端、单个 Agent 进程

**Console（平台壳，R1 退役）**:  
退役中的平台壳，仅保留登录/改密/审计/用户/系统状态等平台页面；产品唯一网页端是 support-web（本仓 solutions/ 子目录）。  
_Avoid_: Core、旧 CocoCat Console、在 Console 承载业务页面

**用户**:  
获得封闭发放账号、可登录产品网页端（support-web）等客户端的系统使用者。  
_Avoid_: End User、Channel Host 机器身份

**End User**:  
通过任一消息通道与 Core 对话的外部对象。  
_Avoid_: 登录用户、账号、Channel Host 机器身份

**共享工作空间**:  
所有登录用户共同操作的一套会话、联系人、知识、记忆和 Agent 配置。  
_Avoid_: 多租户、每用户独立空间

### 对话与知识

**Channel**:  
Core 通过 Channel Host 对接的消息通道。Core 只依赖通道中立的事实（入站事件、发送操作、媒体、游标、会话类型 chatType），不绑定具体通道实现或通道登录账号。  
_Avoid_: 具体通道的原始消息库、通道登录账号

**Conversation**:  
Core 中与通道无关的标准化消息、处理状态、游标和发送结果集合。  
_Avoid_: Channel Host 原始消息库、Memory

**Message**:  
Conversation 中的一条标准化消息，携带方向（inbound/outbound）、发送状态与幂等键；出站回复按 `reply_segments` 语义持久化为独立 Message。  
_Avoid_: Channel Host 原始消息、模型输出本身

**Contact Profile**:  
人工维护的对方身份映射、标签、类型、Agent 开关和知识关联。  
_Avoid_: 自动学习的偏好、登录用户资料

**Memory**:  
从跨轮对话中提取的长期事实、偏好和关系信息。  
_Avoid_: 完整聊天记录、知识库、Contact Profile

**Knowledge**:  
经摄入、索引并可追溯检索的外部资料。  
_Avoid_: 聊天记录、Memory、原始文件本身

**Handoff**:  
需要人类接管或处置的业务状态及其生命周期；平台级概念，不绑定具体通道或业务场景。  
_Avoid_: 通道维护指令、普通消息状态

**Media**:  
以 `mediaId` 引用并由 Core 管理元数据、派生结果、访问和保留期的非文本内容。  
_Avoid_: Conversation 中的 Base64、知识文档

**Asset**:  
素材空间中持久持有的可复用非文本内容（`assets.items`，按 image/file 分类），上传即入空间、可搜索、可整理（重命名/软删除）；发送时按「素材 + 会话 + clientRequestId」确定性派生 `mediaId` 走 Media 出站链路，文件字节无需重复上传。  
_Avoid_: 一次性 manual-upload 文件（ownerModule=manual-upload）、知识文档

**Agent Turn**:  
针对一次触发，由 Execution Strategy 决策、上下文组装、模型推理和工具执行组成的编排过程。AgentDecision 的字段与动作枚举由决策契约（`decision-contract.ts`）单点定义，正式动作集为 reply / ask_for_information / retrieve_knowledge / call_tool / handoff / no_action / wait / end_session / schedule_send。  
_Avoid_: 常驻聊天会话、模型调用本身

**Agent Turn Execution**:  
一次可恢复、可审计的 Agent Turn 编排过程，包含领取、上下文、决策、工具检查点、结果提交和终态恢复。  
_Avoid_: 单次模型调用、常驻聊天会话、队列 Job 本身

**Execution Profile**:  
决定会话是否及如何运行 Agent 的执行配置，由业务插件注册提供；Core 通过 ExecutionStrategyRegistry 按 strategy 选择 Execution Strategy。  
_Avoid_: 内置业务策略、硬编码 Prompt

### 回合与线程

**回合（Episode）**:  
从首次触发到机器人自主收口（wait 交权 / end_session / 预算耗尽）的一段连续服务过程；客户插话是回合内部事件，不是回合边界。  
_Avoid_: Conversation、单次 Agent Turn、模型调用

**回合吸收（Absorbed Input）**:  
回合运行中到达的客户补充消息被并入当前回合而非另起新回合的机制；排队的旧轮标记 superseded（absorbed_into），当前回合作废过时决策或在含插话的新鲜上下文上重决策。  
_Avoid_: 消息排队重放、旧 supersede 抢占语义、简单重试

**会话事实卡（Fact Card）**:  
每会话一份的结构化当前状态（当前问题 / 已确认事实 / 已尝试方案 / 未兑现承诺 / 待确认问题），随决策全量更新、回合开头注入上下文。  
_Avoid_: Memory、Conversation 摘要、Contact Profile

**轮窗（Round Window）**:  
原文窗口之外的更早回合的摘要化上下文（最多 4 行、72h 窗）；回合从精确落库的轮次重建，不在回合中间截断。  
_Avoid_: Memory、完整转录

**群聊线程（Group Thread）**:  
群聊中由 @ 命中开启的话题单元（`session:group-thread:` 前缀的 agent session）；线程存活期内群成员消息免 @ 建轮，由 end_session 或 TTL 收线。  
_Avoid_: 群 Conversation、私聊回合

**Session Wake（自唤醒）**:  
wait 决策挂起的等待计时器到期后由系统投递的唤醒，让回合在客户未回复时继续推进。  
_Avoid_: 定时轮询、cron 任务

## Relationships

- 一个 **Channel Host** 运行一个通道实例，并连接一个 **Core**
- 一个 **Core** 当前只有一个 **共享工作空间**
- 一个 **共享工作空间** 包含多个 **用户** 和多个 **End User**
- 每个 **用户** 可登录产品网页端（support-web）等客户端
- **用户** 分为 **operator** 与 **admin**；两者都可处理会话，只有管理员可管理账号、知识、策略和系统
- 一个 **End User** 对应一个 **Contact Profile**，并拥有零个或多个 **Conversation**
- 一个 **Conversation** 可引用多个 **Media**
- 多个 **Media** 可源自同一个 **Asset**（素材转发不复制文件字节）
- **Memory** 关联 End User 或会话语境，但不保存完整 **Conversation**
- **Knowledge** 可被 **Contact Profile** 关联，并在 **Agent Turn** 中按需检索
- **Handoff** 由策略或用户触发，只能通过客户端处理，不通过通道指令处理
- 一个 **Execution Profile** 由业务插件注册提供，引用一个 **Execution Strategy** 与一组 **Skill**（见 Platform vocabulary）
- 一个 **回合（Episode）** 由若干 **Agent Turn** 组成，以机器人自主收口结束
- 一个 **Conversation** 至多有一份 **会话事实卡**；群聊 **Conversation** 可并存多个 **群聊线程**

## Example dialogue

> **开发者：** “Console 管理员上传资料后，是不是只属于这个用户？”
> **领域负责人：** “不是。我们只有一个共享工作空间，资料对所有登录用户可读；写操作只对管理员开放并记录实际操作者。”
>
> **开发者：** “End User 也是登录用户吗？”
> **领域负责人：** “不是。用户登录 Console 等客户端，End User 通过 Channel Host 与 Core 对话，两种身份必须分开。”

## Flagged ambiguities

- “账号”曾同时表示通道账号与系统登录账号——已区分为唯一 **Channel Host 通道账号** 和多个 **用户账号**
- “客户端”曾同时指通道端与操作端——本文只将 **Console** 等操作端称为客户端，通道侧称 **Channel Host**
- “记忆”曾混指 transcript、Wiki 和长期关系事实——已分别定义为 **Conversation**、**Knowledge** 和 **Memory**
- “模块”容易被理解为独立进程——本文中的模块默认只是代码职责分区，只有运行拓扑文档明确列出的才是进程
- 旧项目的“Console 唯一入口”不再成立——Core 的唯一外部入口是 Core Gateway，各客户端均为独立客户端
- 客服业务词汇（intent、stage、case-facts、reply policy、coach 评测等）已随平台化重构迁出 Core——Agent 流程由 Execution Strategy / Skill 插件承载，不再作为 Core 领域语言保留
- `@chatroom` 后缀是微信 wire 细节，不是 Core 领域语言——协议 v6 起 Host 经 `conversationKind` 上报会话类型，Core 仅在 ingest 回退处认识后缀（ADR-0010）；群聊机器人昵称等业务缺省由产品仓部署种子提供（ADR-0011），引擎缺省一律中立
- `no_action` 原因码有两个口径：契约枚举 10 值（含 `session_closed`），面向模型的提示词仅列 9 值——`session_closed` 由系统在 end_session 无收尾话术等场景自行申报；该差异是否纯属有意，待确认
- 决策动作存在分层：Core 决策契约为 9 值全集（`schedule_send` 受联系人级开关控制、缺省关闭），业务策略提示词协议为其 8 值子集——差异是分层设计，不是漂移

## Compatibility vocabulary

旧文档、持久化字段和过渡 Adapter 可能仍出现 `Server1`、`Server2`、`Client1`、`Client2`。它们分别对应 Channel Host、Core、Mobile、Console；Mobile 现为产品移动端客户端。新代码和新文档使用正式名称。

## Platform vocabulary (Phase 7 → R3 重定性)

**Platform**:  
Weflow 的可独立发布产品层，包含 Core、Contracts、plugin-sdk 与 weflowctl。R3 平台化拆除后不再有 Solution Runner / npm 市场 / 方案注册表。  
_Avoid_: 具体业务方案、单一通道运行单元、Solution Store

**Plugin**:  
通过公开 SDK 在 Platform seam 上扩展能力的包；分为 Provider、Tool、Skill、Execution Strategy 等类型。业务插件由 Core 从 `WEFLOW_PLUGIN_DIR` 指向的插件目录直读加载，不经打包安装流程。  
_Avoid_: 直接导入 Core 源码的内部模块、solution pack 安装契约

**Execution Strategy**:  
决定 Agent 如何构建模型请求、解析模型响应并校验动作的插件化策略；不得直接调用模型、数据库、Channel 或执行工具。  
_Avoid_: 内置业务 Prompt 兜底

## Compatibility vocabulary (R3)

`Solution Pack`、`Solution App`、`Solution Installation`、`Desired/Observed State`、`consoleExtensions`、`ExtensionHost` 与 npm 市场相关词汇已随 R3 平台化拆除全部退役；旧文档与迁移 journal（0048–0053）中可遇到，新代码与新文档一律不再使用。`solution.extension_settings` 表保留，但语义已重定义为设置中心的通用 JSON 设置存储（主键 scope/key）。
