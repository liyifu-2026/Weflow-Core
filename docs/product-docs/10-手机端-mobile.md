# 10 · 手机端 Mobile（@weflow/mobile）

> 出处：`solutions/customer-support/apps/mobile/`（junction → 实体路径 `C:\dev\mobile`）、
> 其 `AGENTS.md`、`docs/dev-debug.md`、`docs/mobile-spec.md`、`CHANGELOG.md`。
> 定位：**内部客服的移动工作台**——「接近专业人士每天使用的高级移动应用，而不是管理后台」。
> 不提供系统管理、知识库、模型、回复策略版本等管理功能（README 明确）。

## 1. 技术栈与身份

| 项 | 值 |
|----|-----|
| 框架 | Expo SDK 57 + React Native 0.86.3 + React 19.2.3 + TypeScript ~6.0 |
| 路由 | expo-router ~57.0.19（typedRoutes、reactCompiler 实验开启） |
| 包名/版本 | `@weflow/mobile` **0.9.0**（versionCode 3）；applicationId `com.weflow.mobile`；scheme `weflow-mobile`；slug **必须 `weflow-client1`**（EAS 关联绑定，误改会被拦） |
| UI/列表 | reanimated 4.5 + gesture-handler + screens + safe-area + `@shopify/flash-list` 2.0.2 + phosphor 图标 |
| 媒体 | expo-image / video / audio / image-picker / image-manipulator / document-picker / sharing / file-system |
| 基础设施 | expo-notifications（FCM 推送）、expo-secure-store（token）、expo-updates（OTA）、expo-dev-client |
| 测试 | vitest（25 个测试文件，138 用例） |
| Android | compileSdk/targetSdk 35、minSdk 24、AGP 8.12.0；Firebase project `clientpe-cfe33` |
| 服务器地址 | **固定常量** `https://api.leaif.com`（`app.json` extra.apiBaseUrl）；**无配置 UI**——生产 API 域名必须固定，禁止接受用户输入任意地址（安全红线）；release 强制 HTTPS（非 https 配置求值即抛错） |
| 实体路径 | `C:\dev\mobile`（junction 别名只用于 git；构建/安装一律走实体路径——Windows 工具链受不了深层路径） |
| iOS 现状 | **未启用**：代码层面跨平台（Expo，`pnpm ios` 脚本在），但当前仅 Android 完成构建/推送/OTA 全链路验证；无 Apple 开发者账号配置、无 iOS 推送证书、`docs/` 无 iOS 发布流程——文档与发布物均只覆盖 Android |

## 2. 屏幕清单（expo-router `app/`）

| 路由 | 页面 | 要点 |
|------|------|------|
| `app/index.tsx` | 登录 | 本地会话有效直接进工作台；「下次自动登录」= 账密加密存 SecureStore 冷启动静默登录（触屏即取消）；最近账号头像横滑条 + 「+」；临时密码（mustChangePassword）不记住；登录成功**立即注册推送设备** |
| `app/change-password.tsx` | 修改密码 | 首登强制进入（只允许改密或退出）；新密码 ≥12 字符 |
| `app/(tabs)/index.tsx` | 工作首页（Handoff Inbox） | **不再使用底部导航**（`(tabs)` 目录名是历史遗留，实际是 Stack）；微信式左右滑两页——会话页（需要处理橙 → 我处理中蓝 → Agent 处理中灰 → 普通会话；分组可折叠；左滑隐藏；快捷接手/接管；FlashList 虚拟化）＋联系人页（通讯录 + 资料卡：自动回复开关/拉黑/首联时间/历史会话数/最近处理人） |
| `app/conversation/[id].tsx` | 会话详情（~1900 行） | 游标分页（最近 50 条向上加载）；SSE + 30s 轮询；Handoff 状态驱动底栏（接手/输入框/转交/结束/接管）；幂等发送 + 乐观气泡 + unknown 后台 2.5s×8 自动复查；图片/文件/素材发送；语音播放+转写；图片全屏（原图优先）；引用回复；拍一拍；协作请求存量操作；联系人资料查看/编辑；Handoff 历史时间线；结构化 Brief（建议首句一键填入）；本地草稿（按账号+会话+Cycle 隔离，`stale_revision` 门控）；离线只读 |
| `app/hidden-conversations.tsx` | 已隐藏会话 | 恢复显示 |
| `app/me.tsx` | 账号与设备 | 通知预览开关、主题（跟随系统/浅/深）、头像选择、**切换账号**（manual 参数跳过静默登录）、**退出并清除本机数据**（双动作分离）、版本信息 |
| `app/profile.tsx` | 信息名片 | 对外形象：头像/显示名（1–24 字符）/专家标签芯片（词表 `/auth/tag-vocabulary`，上限 7，与专家队列同源→定向路由）；旧 Core 无 agentProfile 能力时隐藏编辑区 |
| `app/notification-settings.tsx` | 通知与隐私 | 服务端预览策略（跨设备）+ 系统权限（本机）两层独立；三类开关 `handoff_pending`/`handoff_assigned`/`assignee_inbound`（全关=自动恢复全部订阅） |
| `app/security.tsx` | 安全与关于 | 静态说明（本机存储/隐私/版本） |

全局 `_layout.tsx`：401 → 清 session 回登录；冷启动存储键迁移（SHA256 按账号哈希）+ 注册推送；
通知点击 → 跳会话详情；**App 进后台显示隐私遮罩**（「Weflow / 客户内容已隐藏」）。

## 3. 认证与数据安全

- Token = **一次性不透明 session token**（非 JWT），`POST /api/v1/mobile/auth/login` 签发；
  仅存 **Expo SecureStore**（Keychain/Keystore；Web 退化内存存储），绝不 AsyncStorage/日志/URL。
- 本地过期主动校验（`expiresAt` 过期/畸形即清，不等 401，防隐私窗口）。
- 30 天长时效 + 服务端滑动续期（15 天内活跃即续）。
- 两级失效：`invalidateSession()`（token 失效，**保留草稿/离线缓存**——产品决策）vs
  `clearSession({clearLocalData:true})`（显式退出，全清）。
- **能力协商**：`GET /api/v1/mobile/capabilities` 返回 14 项能力门——`mobileHandoffInbox`、
  `handoffRevision`、`structuredBrief`、`transferCycle`、`transferToUser`、`transferToQueue`、
  `transferFallback`、`humanFinish`、`handoffOutcomeQuery`、`requestOutcome`、
  `structuredSuggestion`、`suggestionV2`、`mobileManualTakeover`、`agentProfile`；
  404 = 旧 Core，全部回退 false（对应功能隐藏）。
- 图片缓存**只进内存不落盘**（0.9.0 修复隐私缺口；登出后客户图片不留本机）；
  离线 transcript 缓存上限 20 会话/100KB/单会话 12KB/24h 过期，图片文件只存占位文本。

## 4. 推送（Expo Push / FCM）

- `getExpoPushTokenAsync`（projectId `bf04db66-...`）→ `PUT /api/v1/mobile/notification-device`
  （附 showPreview 与 notifyKinds；缺省=服务端默认全订阅）。触发：冷启动 + **登录成功后立即**。
- 自愈：注册失败记待注册意图，回前台 3 秒后自动重试直到 Core 确认。
- 通知类型三类；**新设备默认隐藏正文**（showPreview=false）；角标只统计「需要立即处理」
  （pending + transfer_target）。
- 本地同步**不再生成本地通知**——跨进程推送统一由 Core 的 Expo Push dispatcher（notification
  outbox）负责（消除重启后横幅轰炸）。
- Push 是提醒不是业务事实/抢单凭据；收到必须回拉 Core。
- 边界：模拟器镜像带 GMS 可收 FCM；无 GMS 机型（华为新机等）收不到推送（已知边界）。

## 5. 附件口径（手机端实现）

- **发图片**：ImagePicker（quality 0.8）→ 长边 >2048 等比缩 + 统一 JPEG（顺带归一化 HEIC）→
  `POST /media`（60s 超时）→ 发送 `{mediaId…}`。
- **发文件**：DocumentPicker → 上传 → 发送（text=文件名）。手机端**不发语音**（只有播放）。
- **素材空间**：AssetPickerSheet 三 Tab（本机文件/图片空间/文件空间），搜索+分页+改名/软删；
  发送 `{assetId}` 服务端复用已存文件转发不重传。
- **收图片**：受鉴权 URI 直载（headers.authorization），memory 缓存；全屏查看器原图优先、
  标注「仅在线查看 · 不保存到本机」。
- **语音**：微信式气泡 + 转写文字；`audio/silk`（上游转码不可用）显示不可播占位但转写仍显示。
- **视频**：文件卡片 + 下载后应用内 expo-video 模态预览（mp4/mov）。
- **其他文档**：文件卡片（PDF/DOC/XLS/PPT/ZIP/TXT/视频角标 + MIME 全量显式映射，默认
  octet-stream 兜底）→ 带认证头下载到 cache（token 不进 URL）→ 圆形进度 → expo-sharing
  系统分享面板打开；已下载直接预览。
- 表情包一律纯文本 `[表情包]<含义>`；拍一拍居中系统提示。

## 6. 与网页端/桌面端的功能差异

- **手机端没有**：用户管理/审计/系统状态/白名单页/AI 员工配置/定时任务管控/管理后台、
  独立知识工作台（0.8.0 移除）、建议回复入口（0.9.0 移除，草稿来源统一为人工输入）、
  新建协作请求（存量只读收尾）。
- **手机端独有/特化**：FCM 推送 + 类型订阅 + 预览隐私 + 角标；后台隐私遮罩；SecureStore；
  30 天会话；微信式双页横滑/左滑隐藏/拍一拍/语音气泡；QQ 式多账号快捷登录；OTA 热更新；
  深浅色主题。
- **两端一致闭环**：会话列表/详情、原子接手、幂等人工回复、转交（客服/队列）、结束人工处理、
  联系人资料、素材空间。

## 7. 开发 / 构建 / 发布（`docs/dev-debug.md` 唯一速查）

- 模拟器：AVD `weflow-test`（Pixel 7 / Android 15 API 35 / GMS），
  **必须从中性目录启动**：`cd /c/ && C:\Android\Sdk\emulator\emulator.exe -avd weflow-test`
  （否则模拟器钉住工作目录句柄）；adb `C:\adb\platform-tools\adb.exe`；就绪 = `emulator-5554 device`。
- 日常迭代：`C:\dev\mobile` 下 `pnpm android`（= `EXPO_PUBLIC_ALLOW_INSECURE_HTTP=true expo run:android`，
  允许连内网 http Core）；改代码按 `r` 热刷；首次全量 ~10 分钟。
- 真机调试：`pnpm start` 扫码（同 WiFi）；`scripts/start-lan.sh` 自动探测 LAN IP。
- 提交前三连：`pnpm typecheck && pnpm lint && pnpm test`（25 文件 138 用例全绿）+
  `pnpm exec expo export --platform web`。
- **Release APK**：`CI=1 npx expo prebuild -p android` → `cd android && ./gradlew assembleRelease`
  → `app/build/outputs/apk/release/app-release.apk`（debug keystore 确定性签名，可覆盖安装）；
  prebuild 会全量清空重建 `android/`；改 `app.json` 版本号必须重新 prebuild。
- **发版前核验 OTA 指纹**：`npx expo-updates runtimeversion:resolve --platform android` 必须等于
  `android/app/build/generated/assets/createReleaseUpdatesResources/fingerprint`
  （up-to-date 跳过会把旧指纹烤进 APK，OTA 永远匹配不到；不等就删 fingerprint 重跑）。
- **OTA 发版**（仅 JS 层）：`npx eas-cli login`（owner `leaif`）→
  `EAS_NO_VCS=1 npx eas-cli update --channel production -m "<说明>" --environment production`
  （`C:\dev\mobile` 非 git 目录，必须 `EAS_NO_VCS=1`）；内测 `--channel preview`。
  OTA channel `production` 写在 `app.json updates.requestHeaders`（此前本地 APK 无 channel 头，
  发了也白发——已修）。依赖/原生配置变化必须发新 APK（fingerprint 自动变化，旧安装拉不到新 OTA
  是保护不是故障）。
- **历史坑（已根治）**：cmd.exe 260 长路径 → `pnpm-workspace.yaml` `nodeLinker: hoisted`
  （**不要删**）；ninja/CMake 长路径 → 实体短路径（junction 别名无效，Gradle 会规范化回长路径）；
  expo 包版本偏斜 → `npx expo install --check`；pnpm `Unexpected virtual store location` →
  `CI=true pnpm install`；gradle 文件锁 → `gradlew --stop` + 杀 java.exe；模拟器快照回滚
  致应用"消失" → `adb install -r`；`app/` 下只放路由文件（否则 expo-router 误识别 .ts 为路由）；
  versionCode 只增不减（当前 3）。
- WSL 构建路线曾探索未采用（worklets 在 Linux 配置失败），仅备查。

## 8. Git 与版本约定

- Mobile 属单一 `weflow` 仓；**git 操作必须走仓内 junction 路径**（`C:\dev\mobile` 下无 `.git`）。
- 版本化纪律：每个用户可见功能/契约/迁移/安全/依赖变化先更新 `CHANGELOG.md`（当前 Unreleased
  累积：视频消息可播放、MIME 映射补齐、上传被拒可读提示、图标焕新、OTA channel 头修复、
  versionCode 3、切换账号/登录头像条修复）。
- 测试命名按行为（如 `acceptHandoff rejects already-claimed work`）；必须覆盖竞态——
  冲突后刷新为只读、重试复用 clientRequestId、输出永不重复。
