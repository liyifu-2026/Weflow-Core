# Weflow Packages

独立维护的 Platform SDK / Contract 包（R3 平台化拆除后不再有 Solution Store / solution-sdk）。

| Package | 职责 |
| --- | --- |
| `@weflow-leaif/contracts` | 稳定公共契约：AgentAction、AgentExecutionStrategy、Channel 协议、审计与错误码 |
| `@weflow-leaif/plugin-sdk` | Runtime Plugin Manifest、Capability Token、生命周期、Tool/Skill/Execution Strategy 注册 |
| `@weflow/ui` | Console 平台页面共用的 UI 原语（随 Console 退役，仅存量维护） |

当前每个包独立维护 `package.json` 与 TypeScript 构建，不依赖 Core 源码。

> 2026-09-09 清理：`@weflow/admin-sdk`（唯一消费方已随 R3 拆除）与
> `@weflow/consumer-fixture`（零消费方）已删除。
