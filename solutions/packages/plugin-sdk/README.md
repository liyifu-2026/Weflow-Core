# @weflow/plugin-sdk

Weflow Plugin SDK。

当前包含：

- `RuntimePluginManifest` 与 `CapabilityToken`
- Plugin 生命周期接口
- Tool / Skill / Execution Strategy 注册契约
- `definePlugin` 辅助与 `isPluginManifest` 守卫
- 基础兼容性 testkit

约束：外部 Plugin 只能使用公开 exports，不能深层导入 Core 源码。
