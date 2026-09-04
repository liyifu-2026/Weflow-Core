# Mobile 开发调试速查（agent 手册）

> 目标读者：AI agent / 开发者。手机端日常开发调试的唯一速查入口，改动工作流时同步更新本文件。
> 位置：`weflow-solutions/solutions/customer-support/apps/mobile`，包管理器 **pnpm**，Expo SDK 57 / RN 0.86。

## 场景速查

| 场景 | 怎么做 |
|---|---|
| 日常改 UI / 逻辑（主力） | 先启动模拟器（见下节）→ `pnpm android`；改代码后按 `r` 热刷新，改原生配置才需重新编译 |
| 真机调试 | `pnpm start`（自动探测 LAN IP），手机与电脑同 WiFi，Expo Go / dev client 扫码；连 `http://` 内网 Core 需 `EXPO_PUBLIC_ALLOW_INSECURE_HTTP=true`（`pnpm android/ios/web` 脚本已内置） |
| 发布 JS 层改动（**不重装 APK**） | `npx eas-cli login`（仅首次）→ `npx eas-cli update --channel production -m "<变更说明>"`；内测用 `--channel preview` |
| 推送测试 | 模拟器镜像带 GMS，可收 FCM；真机需有谷歌服务（无 GMS 机型如华为新机收不到推送，已知边界） |
| 提交前验证 | `pnpm typecheck && pnpm lint && pnpm test`（vitest，20 文件 102 用例，全绿为过） |

## 模拟器（本机已配好，2026-09-05）

- AVD：`weflow-test`（Pixel 7，Android 15 / API 35，`google_apis` 带 GMS 镜像）
- 启动：`C:\Android\Sdk\emulator\emulator.exe -avd weflow-test`，或 agent 用 android-emulator 插件 `android_start_emulator(avd="weflow-test")`
- adb：`C:\adb\platform-tools\adb.exe`；SDK root：`C:\Android\Sdk`
- 就绪判断：`adb devices` 出现 `emulator-5554  device`

## OTA 边界（细则见 docs/versioning.md）

- **可 OTA**：`app/`、`src/` 的 TS/TSX 与资源改动（runtimeVersion 用 fingerprint 策略，指纹不变即可热推）。
- **必须发新 APK**：`package.json` 依赖增删升级、`app.json` plugins/权限/原生配置变化——指纹自动变化，旧安装拉不到新 OTA，这是保护不是故障。
- **一次性前提**：当前已装设备需先安装一次含 expo-updates 的 APK，之后才享受 OTA。

## 已知坑

- `npx eas-cli` 未登录时 update 直接失败（EAS owner：`leaif`，projectId：`bf04db66-a706-40eb-aa9c-b0a5dcb4ae13`）。
- Release（preview/production profile）构建强制 HTTPS Core（`app.config.ts` 校验会直接抛错）；本地明文 HTTP 只允许 dev 场景。
- Android 发布验收被 `docs/android-release-prerequisites.md` 里的 google-services.json 新身份问题阻塞（新包名 `com.weflow.mobile` 的新 Firebase 配置未就位）；此事与 OTA 无关，但发新 APK 前必须解决。
- 模拟器首次 `pnpm android` 要跑完整 Gradle 编译，慢是正常的；之后增量构建很快。
