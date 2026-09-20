# ADR-0015: 行为设置命名空间由部署配置绑定，引擎不持业务字面量

日期：2026-09-20
状态：已接受

## 背景

引擎的转人工提醒（api）、群聊策略（api）、Triage 预判分流（agent-worker）、
行为参数（agent-worker）与知识连接器界面分节（infrastructure/knowledge）
都读取设置中心里业务插件的键。此前这五处的命名空间
（`weflow.customer-support`/`support-pipeline`）以字面量硬编码在引擎源码
中——机制通用，但身份是业务的，违反根宪法"引擎层不加业务语义"。
架构评审（2026-09-20 第 2 轮）列为 P1。

## 决策

**命名空间由部署配置 `BEHAVIOR_SETTINGS_REF`（`<solutionId>/<extensionId>`）
绑定；引擎源码零业务字面量。**

- 组合根（apps/*/main.ts）把 `config.behaviorSettingsRef` 传给各读取器。
- 未配置 = 纯平台模式（与 `WEFLOW_PLUGIN_DIR` 未设的语义一致）：转人工提醒
  关闭（文案为空即关闭语义）、群聊策略/分流/行为参数回落引擎中立缺省、
  知识连接器仅 .env 生效。
- 业务部署（产品仓）在自己的 env 中设置
  `BEHAVIOR_SETTINGS_REF=weflow.customer-support/support-pipeline` 激活。

## 备选方案（否决）

插件加载时注册自己的设置命名空间（评审原建议）：更"正统"，但

- 命名空间消费方（api/agent-worker 的 dispatcher 与热加载循环）在插件
  加载之前就要装配，需要引入跨进程的注册表持久化或加载顺序约束；
- 当前唯一业务子树通过部署 env 绑定即可获得同等边界强度，成本小一个
  数量级。

## 后果

- 引擎代码不再出现业务命名空间字面量；评审的边界擦除项关闭。
- 纯平台部署（`WEFLOW_PLUGIN_DIR` 与 `BEHAVIOR_SETTINGS_REF` 均未设置）
  是真正的中立平台；业务行为整体关闭是预期形态，不是故障。
- 若未来多业务子树并存且绑定关系复杂化，可在插件 SDK 上演进为加载时
  注册，届时废弃本 ADR。
