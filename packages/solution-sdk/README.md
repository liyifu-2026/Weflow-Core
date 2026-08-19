# @weflow/solution-sdk

Weflow Solution Pack Foundation 的纯 TypeScript SDK。

当前包含：

- `SolutionManifestV1` / `SolutionLockV1` 类型与严格校验器；
- Manifest/Lock 的规范化序列化与 SHA-256 digest；
- Ed25519 签名验证；
- 纯计算 `Solution Planner`（相同输入产生相同 `planDigest`）。

设计约束来自 Phase 7 主计划：

- Manifest 未知字段、未知组件类型一律拒绝；
- 生产安装只接受受信发布者、有效签名、固定 digest 与完整 lock；
- Planner 是纯计算模块，不执行下载、迁移或部署；
- Secret 只保存引用与缺失状态，不保存明文。
