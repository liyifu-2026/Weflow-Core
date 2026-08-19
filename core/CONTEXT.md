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

**Console**:  
管理与运营工作台，承载会话、知识、记忆、媒体、Agent 治理和系统管理。  
_Avoid_: Core、旧 CocoCat Console

**用户**:  
获得封闭发放账号、可登录 Console 与 Solution 提供客户端的系统使用者。  
_Avoid_: End User、Channel Host 机器身份

**End User**:  
通过任一消息通道与 Core 对话的外部对象。  
_Avoid_: 登录用户、账号、Channel Host 机器身份

**共享工作空间**:  
所有登录用户共同操作的一套会话、联系人、知识、记忆和 Agent 配置。  
_Avoid_: 多租户、每用户独立空间

### 对话与知识

**Channel**:  
Core 通过 Channel Host 对接的消息通道。Core 只依赖通道中立的事实（入站事件、发送操作、媒体、游标），不绑定具体通道实现或通道登录账号。  
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

**Agent Turn**:  
针对一次触发，由 Execution Strategy 决策、上下文组装、模型推理和工具执行组成的编排过程。AgentDecision 只包含通用字段：`reply_segments`、`next_action`（reply / ask_for_information / retrieve_knowledge / call_tool / handoff / no_action）、`no_action_reason`、`requires_human`、`risk_level`、`handoff_briefing`、`knowledge_query`、`tool`。  
_Avoid_: 常驻聊天会话、模型调用本身

**Agent Turn Execution**:  
一次可恢复、可审计的 Agent Turn 编排过程，包含领取、上下文、决策、工具检查点、结果提交和终态恢复。  
_Avoid_: 单次模型调用、常驻聊天会话、队列 Job 本身

**Execution Profile**:  
决定会话是否及如何运行 Agent 的执行配置，由 Solution 插件安装提供；Core 通过 ExecutionStrategyRegistry 按 active profile 的 strategyRef 选择 Execution Strategy。  
_Avoid_: 内置业务策略、硬编码 Prompt

## Relationships

- 一个 **Channel Host** 运行一个通道实例，并连接一个 **Core**
- 一个 **Core** 当前只有一个 **共享工作空间**
- 一个 **共享工作空间** 包含多个 **用户** 和多个 **End User**
- 每个 **用户** 可登录 **Console** 与 Solution 提供的客户端
- **用户** 分为 **operator** 与 **admin**；两者都可处理会话，只有管理员可管理账号、知识、策略和系统
- 一个 **End User** 对应一个 **Contact Profile**，并拥有零个或多个 **Conversation**
- 一个 **Conversation** 可引用多个 **Media**
- **Memory** 关联 End User 或会话语境，但不保存完整 **Conversation**
- **Knowledge** 可被 **Contact Profile** 关联，并在 **Agent Turn** 中按需检索
- **Handoff** 由策略或用户触发，只能通过客户端处理，不通过通道指令处理
- 一个 **Execution Profile** 由 Solution 安装提供，引用一个 **Execution Strategy** 与一组 **Skill**（见 Platform vocabulary）

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

## Compatibility vocabulary

旧文档、持久化字段和过渡 Adapter 可能仍出现 `Server1`、`Server2`、`Client1`、`Client2`。它们分别对应 Channel Host、Core、Mobile、Console；其中 Mobile 现为 Solution 提供的客户端。新代码和新文档使用正式名称。

## Platform vocabulary (Phase 7)

**Platform**:  
Weflow 的可独立发布产品层，包含 Core、Console、Contracts、SDK、weflowctl 与 Solution Runner。  
_Avoid_: 具体业务方案、单一通道运行单元

**Plugin**:  
通过公开 SDK 在 Platform seam 上扩展能力的包；分为 Provider、Tool、Skill、Execution Strategy 等类型。  
_Avoid_: 直接导入 Core 源码的内部模块

**Solution Pack**:  
一个可安装、可签名、可回滚的业务方案发布单元，由 `solution.manifest.yaml`、`solution.lock.json` 与 `signature.json` 组成；向 Core 注册 Execution Strategy、Skill 等插件能力。  
_Avoid_: Marketplace 商品、任意脚本包

**Solution App**:  
Solution Pack 内独立构建、部署和升级的应用（如独立前端、BFF、移动端）。  
_Avoid_: Console 内嵌页面

**Execution Strategy**:  
决定 Agent 如何构建模型请求、解析模型响应并校验动作的插件化策略；不得直接调用模型、数据库、Channel 或执行工具。  
_Avoid_: 内置业务 Prompt 兜底

**Solution Installation**:  
Core 中描述某个 Solution Pack 安装生命周期的权威事实，包含 desiredState、observedState、healthState 与 Operation。  
_Avoid_: 文件系统上的临时目录

**Desired State / Observed State**:  
Desired State 是管理员期望的方案状态（disabled/active/removed）；Observed State 是 Runner 回报的实际状态（absent/installing/installed/configured/activating/active/degraded/rolling_back/uninstalling/removed/failed）。  
_Avoid_: 把二者混为一个状态字段
