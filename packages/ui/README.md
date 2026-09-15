# @weflow/ui

Weflow 共享 UI 基础包。

当前包含：

- `statusTone` / `validationTone`：状态 → 视觉 tone 映射

后续会从 support-web 增量抽取（Console 已退役冻结，不再是抽取来源）：

- `wf-page / wf-panel / wf-table / wf-inspector`
- `labels`
- 通用组件

策略：一次只抽一个稳定的小单元，并带测试，避免大爆炸式迁移。
