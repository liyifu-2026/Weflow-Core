# ADR-0003：Solution Pack Foundation 与客服方案剥离

## Status

Accepted — Phase 7

## Decision

Weflow 正式分为 **Platform** 与 **Ecosystem** 两层：

- **Weflow Platform** 包含 Core、Console、Contracts、Plugin SDK、Solution SDK、Admin SDK、UI、weflowctl 与 Solution Runner。
- **Weflow Ecosystem** 包含 Provider Plugin、Tool Plugin、Skill Plugin、Execution Strategy Plugin、Solution App 与 Solution Pack。

Customer Support 不再是 Platform 内置产品，而是首个官方 Solution Pack。Core、Console 不得反向导入 Customer Support、Support Web 或 Mobile。

本阶段只新增三个深 Module：

1. **Solution Package Contract**：`solution.manifest.yaml`、`solution.lock.json`、`signature.json` 的严格契约。
2. **Solution Planner**：纯计算 Module，相同输入必须产生相同 `planDigest`。
3. **Solution Installation**：以 PostgreSQL 为权威事实的 desired/observed/health 状态机，由独立 Solution Runner 领取租约执行。

Runtime Kernel 保持现有职责，不承担下载、签名、迁移或部署。

## Scope

- 生产安装只接受受信发布者、Ed25519 有效签名、allowlist registry、固定 digest 与完整 lock 文件。
- 开发环境可以使用 `file:`，但必须显式开启 development mode。
- Manifest 不允许 Shell 安装命令、Core migration、Core 表写入、任意 Console JavaScript/iframe/远程 Vue Module、Secret 明文、未声明权限或未实现组件类型。
- 未知字段和未知组件类型一律拒绝，不能静默忽略。
- Secret v1 只支持 `env SecretRef` 与 `file SecretRef`；Core 只保存引用和“已配置/缺失”状态。
- 卸载只停止未来运行、移除组合关系并归档方案资源；历史 Conversation、Message、AgentTurn、Handoff、Audit 和 provenance 永久保留。

## Consequences

- 客服专用 Prompt、固定 intent/stage 枚举、产品故障字段、Product Troubleshooting Skill、客服追问校验、默认回复策略、Handoff 文案和 Evaluation/Coach 数据集迁出 Core。
- Core 保留通用 Conversation、Case、Handoff、Fact 与 Agent Turn 机制；Reply Policy 与 Evaluation 相关机制已一并迁出 Core。
- Agent Runtime 通用化：新增 Execution Strategy（注册于 ExecutionStrategyRegistry）、SkillRegistry 与 Agent Execution Profile；没有活动且兼容的 Execution Profile 时不创建新 Agent Turn。
- Console 新增 `/platform/solutions`，但不加载 Solution 自定义页面；客服工作台迁入独立 Support Web。
- 原 Phase 6.2–6.7 能力重新归属到插件/方案，不再继续作为 Core 阶段。
