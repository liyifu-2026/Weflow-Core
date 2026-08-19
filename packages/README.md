# Weflow Packages

Phase 7 开始引入独立发布的 Platform SDK/Contract 包。

| Package | 职责 |
| --- | --- |
| `@weflow/contracts` | 稳定公共契约：AgentAction、AgentExecutionStrategy、Runtime/Solution 状态、审计与错误码 |
| `@weflow/plugin-sdk` | Runtime Plugin Manifest、Capability Token、生命周期、Tool/Skill/Execution Strategy 注册与 testkit |
| `@weflow/solution-sdk` | Solution Pack Contract、Manifest/Lock 严格校验、签名验证、纯 Planner |
| `@weflow/admin-sdk` | Console / Solution Runner / 运维工具调用 Core 管理 Interface，响应运行时校验 |
| `@weflow/consumer-fixture` | 外部消费者 fixture，验证只使用公开 exports 即可编译、测试和运行 |

当前每个包独立维护 `package.json` 与 TypeScript 构建，不依赖 Core 源码。
`consumer-fixture` 使用本地 node_modules junction 模拟外部消费者；后续可接入统一 workspace 与发布门禁。
