# ADR-0001：Agent Turn Execution Seam

## Status

Accepted — Phase 3

## Decision

Agent Turn 的正常运行统一通过 `AgentTurnExecutor.execute()` 进入。Worker 只负责队列消费、Capability 注入和进程生命周期，不再自行判断工具动作决策或编排第二个执行入口。

数据库事实是跨 Worker、跨实例的并发权威。进程内 `ConversationTurnExecutor` 只作性能优化；AgentTurn CAS、Case revision、conversation ownership lock、ToolExecution lease 和 Message idempotency 共同决定最终结果。

Agent Turn 的 Case、Message、Handoff、Memory capture schedule、AgentTurn 状态和阶段事件由事务型 Outcome Command 原子提交。模型调用、知识检索和工具 Provider 调用不在数据库事务内执行。

ToolExecution 使用已有表上的领取租约恢复。当前租约周期沿用 5 分钟 stale 阈值；租约过期的只读工具回到 `planned`，已成功的工具结果直接复用。未来具有副作用的工具必须另行建立 effect 与外部 operation seam。

## Scope

本 ADR 不引入通用 Workflow 引擎或多工具编排；Skill Registry 与 Execution Strategy 插件化由平台化重构另行引入（见 ADR-0003）。本 ADR 不修改 Channel、出站 `operationId`、`unknown`、游标或客户端 HTTP 合同。

## Consequences

- Agent Turn 的阶段恢复和审计路径集中，Worker 不再持有业务编排知识。
- Outcome Command 使 Case、Message、Handoff、Memory 调度和 AgentTurn 终态不会出现部分提交。
- ToolExecution 增加租约字段和一条追加 migration；历史 migration journal 不改写。
- 旧流程函数可以作为内部测试兼容适配，但不再是正式运行时入口。
