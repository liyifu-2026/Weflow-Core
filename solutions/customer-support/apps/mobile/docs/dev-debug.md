# Mobile 开发调试速查（agent 手册）

> 目标读者：AI agent / 开发者。手机端日常开发调试的唯一速查入口，改动工作流时同步更新本文件。
> **实体路径：`C:\dev\mobile`**（2026-09-05 从 `Desktop\We\...\apps\mobile` 迁入短路径；旧位置是 junction，仓库操作走旧路径即可，**构建/安装一律走 `C:\dev\mobile`**）。包管理器 **pnpm**，Expo SDK 57 / RN 0.86。

## 场景速查

| 场景 | 怎么做 |
|---|---|
| 日常改 UI / 逻辑（主力） | 先启动模拟器（见下节）→ 在 `C:\dev\mobile` 跑 `pnpm android`；改代码按 `r` 热刷新，改原生配置才需重新编译 |
| 真机调试 | `pnpm start`（自动探测 LAN IP），手机与电脑同 WiFi，Expo Go / dev client 扫码；连 `http://` 内网 Core 需 `EXPO_PUBLIC_ALLOW_INSECURE_HTTP=true`（`pnpm android/ios/web` 脚本已内置） |
| 发布 JS 层改动（**不重装 APK**） | `npx eas-cli login`（仅首次）→ `npx eas-cli update --channel production -m "<变更说明>"`；内测用 `--channel preview` |
| 推送测试 | 模拟器镜像带 GMS，可收 FCM；真机需有谷歌服务（无 GMS 机型如华为新机收不到推送，已知边界） |
| 提交前验证 | `pnpm typecheck && pnpm lint && pnpm test`（vitest，20 文件 102 用例，全绿为过） |

## 模拟器（本机已配好，2026-09-05）

- AVD：`weflow-test`（Pixel 7，Android 15 / API 35，`google_apis` 带 GMS 镜像）
- 启动：**必须从中性目录（如 `C:\`）启动**，否则模拟器进程会把工作目录句柄钉在启动位置，锁死后续的目录改名/搬迁：`cd /c/ && C:\Android\Sdk\emulator\emulator.exe -avd weflow-test`
- agent 也可用 android-emulator 插件 `android_start_emulator(avd="weflow-test")`
- adb：`C:\adb\platform-tools\adb.exe`；SDK root：`C:\Android\Sdk`
- 就绪判断：`adb devices` 出现 `emulator-5554  device`

## 构建路线（Windows 本地，已验证 ✅ 2026-09-05）

**唯一正确姿势：在 `C:\dev\mobile` 下执行 `pnpm android`（即 `expo run:android`）。** 首次全量约 10 分钟，之后增量很快。

三个历史坑（均已根治，复发时按此对照）：

1. **cmd.exe 长路径（260）**：`Cannot run program ...prefab_command.bat` → 已用 `pnpm-workspace.yaml` 里 `nodeLinker: hoisted` 解决（扁平 node_modules，expo-updates 路径从 260+ 降到 ~115）。**不要删 pnpm-workspace.yaml 的 nodeLinker 行。**
2. **ninja/CMake 长路径（~160）**：`manifest 'build.ninja' still dirty after 100 tries` → 已用实体短路径 `C:\dev\mobile` 解决。junction 别名（C:\wef 等）**无效**——Gradle 会把 junction 规范化回真实长路径。
3. **expo 包版本偏斜**：生成代码报 `This API is experimental ...` 编译错误 → 跑 `npx expo install --check` 对齐；pnpm 在搬迁后拒绝增量操作时用 `CI=true pnpm install` 重链。

WSL 路线（`~/node22 + ~/Android/Sdk`）曾作为替代探索，最终未采用（worklets 在 Linux 配置失败未解）；Windows 短路径已通，WSL 仅作备查。

## OTA 边界（细则见 docs/versioning.md）

- **可 OTA**：`app/`、`src/` 的 TS/TSX 与资源改动（runtimeVersion 用 fingerprint 策略，指纹不变即可热推）。
- **必须发新 APK**：`package.json` 依赖增删升级（**2026-09-05 已把 19 个 expo 系包对齐到官方期望版，含 RN 0.86.3**）、`app.json` plugins/权限/原生配置变化——指纹自动变化，旧安装拉不到新 OTA，这是保护不是故障。
- **一次性前提**：当前已装设备需先安装一次含 expo-updates 的 APK（模拟器里已装），之后才享受 OTA。

## 已知坑

- `npx eas-cli` 未登录时 update 直接失败（EAS owner：`leaif`，projectId：`bf04db66-a706-40eb-aa9c-b0a5dcb4ae13`）。
- Release（preview/production profile）构建强制 HTTPS Core（`app.config.ts` 校验会直接抛错）；本地明文 HTTP 只允许 dev 场景。
- Android 发布验收被 `docs/android-release-prerequisites.md` 里的 google-services.json 新身份问题阻塞（新包名 `com.weflow.mobile` 的新 Firebase 配置未就位）；此事与 OTA 无关，但发新 APK 前必须解决。
- **git 操作走旧仓库路径**（`Desktop\We\weflow-solutions`，经 junction）；`C:\dev\mobile` 下 git 找不到仓库根。
- pnpm 在路径/配置变化后报 `Unexpected virtual store location` → `CI=true pnpm install` 重链。
- 改 `app.json` 版本号后必须 `npx expo prebuild -p android` 才会进 APK（版本号在 prebuild 时烤进原生工程）。
- 模拟器挂死/误杀进程后可能回滚到旧快照，**应用会"消失"**——`adb install -r` 重装 APK 即可；构建报 `Unable to delete file ...classes.jar` → `gradlew --stop` + 杀全部 java.exe + 删对应模块 build 目录。
- app/ 目录下只放路由文件；支撑模块放 `src/`，否则 expo-router 会把 .ts 文件误识别为路由。
