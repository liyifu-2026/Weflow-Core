# 版本与变更记录准则

## 目的

Mobile 通过版本号和变更记录向客服、运维人员、Core 集成方及贡献者明确“什么变了、是否需要采取行动”。这是每次功能、契约或安全变化的常规交付物，不是发布前的补写任务。

## 版本号

使用语义化版本 `MAJOR.MINOR.PATCH`：

- `MAJOR`：不兼容的登录、API、数据或交互语义变化。
- `MINOR`：向后兼容的新功能，例如新页面、筛选项或 Core 可选字段。
- `PATCH`：向后兼容的缺陷、安全、性能或文案修复。

预发布使用 `-alpha.N`、`-beta.N` 或 `-rc.N`。移动构建号与商店版本由发布流程单独维护，但必须可追溯到同一应用版本。

## 每次变更的要求

在开始实现用户可见功能、Core 契约、认证、安全、数据迁移或依赖升级时，先在 `CHANGELOG.md` 的 `Unreleased` 下建立条目；完成后更新条目和验证结果。按以下类别归档：

- `Added`：新能力。
- `Changed`：已有行为或契约变化。
- `Fixed`：缺陷修复。
- `Security`：认证、权限、隐私、存储或依赖安全变化。
- `Deprecated` / `Removed`：弃用或删除能力。

条目写明行为和影响，不写内部文件重命名。例如写“非负责人不能发送人工消息”，而不是“修改 create-manual-reply.ts”。

## 发布切换

发布版本时：

1. 将 `Unreleased` 中已验证内容移到新版本标题，并写入 ISO 日期。
2. 更新 `package.json` 的 `version`，以及所需的 Expo/iOS/Android 构建版本。
3. 标注 Core 最低契约或迁移要求；破坏性变化写出升级与回滚方式。
4. 运行 `npm run typecheck`、`npm run lint` 和适用的 Expo 构建/真机验证。
5. 不发布未在 Changelog 说明的用户或契约变化。

紧急修复也遵循此流程，只是使用 PATCH 版本并在 `Fixed` 或 `Security` 中说明风险和影响。

## OTA 更新边界（EAS Update）

移动端启用 expo-updates（runtimeVersion 策略：`fingerprint`）。JS 层变更可经 OTA 热更新，无需重新分发 APK；边界如下：

**可以走 OTA**（`runtimeVersion` 指纹不变）：

- `app/`、`src/` 下的 TS/TSX 代码与资源（图片、字体）变更；
- 不影响原生行为的 `app.json` 字段（如 `extra`、文案类配置）。

**必须发新 APK**（指纹变化，OTA 对旧安装自动失效）：

- `package.json` 任何依赖增删或升级（expo-updates 依赖参与指纹计算，谨慎对待）；
- `app.json` 的 plugins、权限、图标、splash、原生构建属性（`expo-build-properties`）变化；
- 任何需要新原生模块能力的功能。

**操作流程**：

1. `npx eas-cli login`（账号为 EAS owner `leaif` 下的成员）；
2. 确认本次变更属于「可以走 OTA」范围，且 CHANGELOG 已按上文要求更新；
3. 推送：`npx eas-cli update --channel production -m "<变更说明>"`（内测用 `--channel preview`）；
4. fingerprint 不一致的设备不会拉取本次更新（服务端按 runtimeVersion 匹配），这是预期保护，不是故障；
5. OTA 只覆盖 JS：Core 契约变更若依赖新原生能力，必须走完整发版，不得用 OTA 强推。

