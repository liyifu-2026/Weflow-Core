# ADR-0002：平台 Agent 闭环——策略与技能由 Solution 插件提供

## Status

Accepted — Phase 4（Phase 7 平台化重构后更新为平台 Agent 闭环）

## Decision

Agent 自动回复、自动追问、自动转人工与人工接管构成平台级闭环。闭环的策略与技能不内置在 Core 中，而是由 Solution 插件提供：

- **Execution Strategy**（注册于 ExecutionStrategyRegistry）决定模型请求构建、响应解析与动作校验；System Prompt 由策略提供，无策略时使用内置通用平台 Prompt。
- **Skill**（注册于 SkillRegistry）是可复用的领域技能，由 Solution 插件注册；Core 不内置任何业务技能。
- **Execution Profile** 由 Solution 安装提供，决定会话是否及如何使用哪个 Execution Strategy 与 Skill 集合；无活动且兼容的 Execution Profile 时不创建新 Agent Turn。

人工接管入口保持为客户端：Console 是完整的管理/运营工作台，展示 Conversation、Handoff、结构化交接摘要、知识依据、Agent 建议和人工处理动作；Solution 可提供自己的客户端（如独立前端、BFF、移动端）。

Core 是所有闭环事实的唯一来源；客户端不从 Transcript 自行推断 Conversation、Agent Turn 或 Handoff 状态。

Agent 自动检索产生的知识依据来自已成功持久化的 `retrieve_knowledge` ToolExecution。对客户端只返回经过投影的公开字段；不返回模型思维链、检索分数、原始 Provider 字段或本地路径。

建议回复绑定 `conversationRevision`。会话 revision 变化后建议立即失效，禁止继续采用。

## Scope

本 ADR 只收敛平台 Agent 闭环（自动回复、自动追问、自动转人工与人工接管）的插件化策略来源。不引入新 Channel、通用 Workflow、语音视频、CRM 或自助门户。

## Consequences

- Core 不再内置任何业务策略或 Prompt；策略与技能变更通过 Solution 插件安装与 Execution Profile 切换完成。
- UI 改动集中在现有管理/运营工作区与 Solution 提供的客户端，保持产品可用性和已有操作语义。
- Agent 实际使用过的知识依据能够被运营人员追溯查看。
- stale Suggestion 不会被误发送；Core 仍是 revision 和权限裁决者。
- Agent ToolExecution 结果继续由数据库保存，未新增 execution ledger 或改变 Channel 合同。
