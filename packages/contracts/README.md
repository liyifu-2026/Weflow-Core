# @weflow/contracts

Weflow Platform 的稳定公共契约包。

当前包含：

- `AgentAction` 与 `AgentExecutionStrategy` 类型；
- `ToolObservation`、`RuntimeStatus`、Solution State 类型；
- Audit 事件与错误码；
- 最小 HTTP API envelope；
- `isAgentAction` 运行时守卫。

约束：外部 Plugin / Solution App 只允许使用本包公开 exports，不能深层导入 Core 源码。
