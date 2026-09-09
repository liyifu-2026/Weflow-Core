# Mobile 0.7.0 验收清单（Acceptance）

> **本文件是 Mobile 0.7.0「完成」的唯一定义。**
> 只有下列全部项目打勾，才能宣称「Mobile 0.7.0 完成」。任一项目未通过，发布状态一律记为「未完成 + 阻塞项清单」，不允许凭感觉口头宣布完成。
>
> 规则：
> - 每项必须写明**验证方法**和**通过标准**，验收时逐项执行、当场记录。
> - 环境不可用导致无法验证时，把该项记为 **`⛔ 环境阻塞`** 并注明缺失资源，**禁止伪造成功状态**（参照 `../handoff-CP9M6n.md` 交接约束）。
> - 业务合同以 `docs/mobile-spec.md` 为准；Core 行为以 `weflow-server/docs/adr/0019-mobile-handoff-v2-contract.md` 为准；本清单不定义新行为。
> - 后端集成测试文件：`weflow-server/tests/mobile-handoff-v2.integration.test.ts`（8 条场景，与 D 节一一对应）。

---

## A. 前置环境与工具

> 全部就绪后才开始 D 节真机验收。任何一项缺失，先解决或标记环境阻塞。

- [x] **A1. 生产/验收 HTTPS Core 地址**
  - ✅ 2026-08-12 验证通过：`https://api.leaif.com`（用户域名 leaif.com + 香港 VPS + Caddy 自动 TLS + frp 隧道 → 本机 Core :3100）。
  - 验证记录：`https://api.leaif.com/health/live` → `{"process":"core","status":"ok"}`；`/health/ready` → `ready`；证书 Let's Encrypt（CN=api.leaif.com）有效至 2026-11-09，Caddy 自动续期。
  - 基础设施：VPS `38.22.235.27` 上 frps(:7000) + Caddy(:80/:443) 以 systemd 运行；本机 `~/frpc/frpc.toml` 客户端连接（remotePort 28660）；ufw 已放行 7000/443/80。
  - 旧临时入口 `https://meter-regulation-rather-sword.trycloudflare.com`（cloudflared 快速隧道）已验证后**停用**，不作为正式入口。
- [ ] **A2. Android 真机 ≥ 1 台**
  - 事实记录（2026-08-12）：`platform-tools` 已安装（adb 37.0.1，PATH 已写入 `~/.bashrc`）；`adb devices` 可检测设备。
  - 通过标准：`adb devices` 显示设备；能 `adb install` 和查看日志。**待用户插上真机确认。**
- [ ] **A3. iOS 真机 ≥ 1 台（或明确声明 iOS 延后）**
  - 事实记录：本机为 Linux，无法本地 iOS 构建；iOS 需 EAS 云构建 + Apple 证书/描述文件。
  - 通过标准：能安装 Preview IPA（TestFlight 或 ad-hoc）并完成 D/F 节。
- [ ] **A4. WeChat Channel Host 真实微信通道可用**
  - 事实记录：`wechat-runtime` 在 `127.0.0.1:6174` 运行且 `/health` 返回 ok；`runtime/real-accept/auth-token` 生成于 2026-07-29（65 字节，已过期风险高）。
  - 通过标准：WeChat Channel Host 能真实收发微信客户消息（G 节实测为准），微信登录 token 有效。
- [ ] **A5. Push 链路就绪**
  - 事实记录：Core 使用公开 Expo Push API（`infrastructure/notifications/expo-push-dispatcher.ts`，端点 `exp.host/--/api/v2/push/send`），**无需服务端凭据**；App 已配置 EAS projectId `bf04db66-a706-40eb-aa9c-b0a5dcb4ae13`。
  - 通过标准：`expo-notifications` 在真机拿到 Expo Push Token 并能被 `notification-device` 注册接口接受；Core 的 `notification_outbox` 状态流转（pending → sent / failed）可观察。
- [ ] **A6. Core 本地运行环境健康**
  - 通过标准：Core `:3100`、Agent Worker `:3101`、Ingestion Worker `:3102` 健康检查均 ok；PostgreSQL / Redis 可达；迁移已执行（含 0035、0036）。
- [ ] **A7. 测试账号与数据准备**
  - 通过标准：存在至少 2 个客服账号（A/B）、1 个管理员账号、1 个专业队列（含 A 不含 B）、1 个客户微信；所有账号完成首次改密且状态正常。

## B. 静态门禁（每次构建前必须全绿）

- [ ] **B1. 单元测试**：`npm run test` → 24 个测试文件、138 个测试全部通过（基线 2026-08-11 已验证）。
- [ ] **B2. 类型检查**：`npm run typecheck` 零错误。
- [ ] **B3. Lint**：`npm run lint` 零错误。
- [ ] **B4. Web 导出**：`EXPO_PUBLIC_API_BASE_URL=https://<验收地址> npx expo export --platform web` 成功（顺带验证 Metro/静态路由可打包）。
- [ ] **B5. 版本一致性**：`package.json`、`app.json`、`CHANGELOG.md` 版本一致（0.7.x）；`Unreleased` 内容已归档或明确发布说明。
- [ ] **B6. 配置守卫**：未设 `EXPO_PUBLIC_ALLOW_INSECURE_HTTP=true` 时 release 构建拒绝明文 HTTP（`app.config.ts` 断言生效）；`EXPO_PUBLIC_API_BASE_URL` 非 HTTPS 时 preview/production 构建直接失败。

## C. Core 集成回归（本地，无需真机）

> 对应 `weflow-server/tests/mobile-handoff-v2.integration.test.ts` 的 8 条场景；Mobile 侧验收的是对应客户端行为。命令：`corepack pnpm test`。

- [ ] **C1. Agent 普通转人工只进入专用 Mobile Inbox**（测试：`Agent 普通转人工只进入专用 Mobile Inbox`）
- [ ] **C2. 高风险 Handoff 由 Core 排前**（测试：`高风险 Handoff 由 Core 排在普通 Handoff 之前`）
- [ ] **C3. 两名客服并发接手仅一人成功**（测试：`两名客服并发接手时严格只有一人获得发送权`）
- [ ] **C4. 转给具体客服须目标明确接手**（测试：`转给具体客服后必须由目标客服明确接手`）
- [ ] **C5. 目标拒绝进入 fallback queue**（测试：`目标客服拒绝后进入 Core 决定的 fallback queue`；超时路径另行验证 A7 计时）
- [ ] **C6. 转专业队列仅合法成员可接手**（测试：`转专业队列后仅合法队列成员可以接手`）
- [ ] **C7. 转交期间客户新消息使旧快照失效**（测试：`转交确认期间客户补充消息会使旧快照失效`）
- [ ] **C8. 结束后异步总结，Agent 只继承受控结果**（测试：`结束人工处理后异步生成总结，下一次 Agent 只继承受控结果`）

## D. Android 真机主链（全流程冒烟，验收核心）

> 两台客服真机（A、B），客户端使用 **Release 构建产物**（见 E 节），连接生产/验收 HTTPS 地址。按顺序执行，一步失败即停止并记录。

- [ ] **D1. 登录与首次改密**：A 用新账号登录 → 被强制要求改密 → 改密后进入唯一 Inbox；错误密码、禁用账号显示正确错误文案（不显示堆栈）。
- [ ] **D2. Inbox 两分段**：无 Handoff 时「等待接手 / 我处理中」均空；不显示普通 Agent 会话、不出现能力未开放错误。
- [ ] **D3. 等待接手（Pending）**：Agent 侧制造普通转人工 → A 的 Inbox 出现该会话，显示联系人、问题摘要、转人工原因、等待时间；进入详情只显示 Brief + Transcript + 唯一主操作「接手处理」，**无 Composer、无建议生成请求**。
- [ ] **D4. 接手**：A 点击「接手处理」→ Composer 平滑出现（不自动弹键盘）；此时 B 打开同一会话为只读，且 B 的 Inbox 中该项消失。
- [ ] **D5. Brief 展示**：Structured Brief 完整展示 `problemSummary / confirmedFacts / triedSteps / missingInformation / unresolvedItems / handoffReason / suggestedNextStep / suggestedFirstReply`；「摘要有误」反馈可提交且不改变责任状态。
- [ ] **D6. 人工回复**：A 发送消息 → 状态按「发送中 → 已受理/已发送」流转；消息以人工身份呈现，对客文案不含「转人工/Agent/智能客服」字样；客户侧（微信）能收到。
- [ ] **D7. 建议回复（如启用）**：生成建议 → 查看依据 → 采用进草稿 → 编辑 → 主动发送；过期建议不能采用；**任何路径都不自动发送**。
- [ ] **D8. 转给具体客服**：A 发起「转交处理」→ 选 B → 填写必填原因 → 确认页展示 Core 结构化交接快照（含 acceptBy 15 分钟、fallback 信息）→ 成功后 A 立即只读、Composer 消失。
- [ ] **D9. 目标接受**：B 收到 TRANSFER_PENDING 提醒 → 打开会话出现「接受 / 拒绝」→ B 接受 → B 获得发送权限并回复 → 消息送达客户。
- [ ] **D10. 结束人工处理**：B「结束人工处理」→ 结束确认 → Composer 消失、会话只读；A/B 的 Inbox 中该项从「我处理中」消失；不阻塞等待 resolutionSummary。
- [ ] **D11. Agent 接续**：结束之后客户（微信）再次发消息 → Core 显示 Agent 接管处理；Agent 上下文只含处理结果、总结、最终事实、未解决事项，**不含客服姓名与内部转交链**（可在管理台审计核对）。
- [ ] **D12. 会话详情健壮性**：游标向上分页加载历史；下拉刷新不重置阅读位置；网络断开时显示离线状态、发送失败显示可重试，**不伪造「已送达」**。

## E. Release 构建与安装

- [x] **E1. 废弃旧 APK**：2026-08-04 的 `app-release.apk`（指向已死隧道 `frp-fly.com:28660`）已作废，不再作为验收依据。
- [x] **E2. Android Release 构建**：2026-08-12 本地 Gradle 构建成功（`EXPO_PUBLIC_API_BASE_URL=https://api.leaif.com ./gradlew assembleRelease`，7m52s）。
  - Android 发布验收暂缓：正式包名已收敛为 `com.weflow.mobile`，等待 Firebase 提供 `package_name` 同为 `com.weflow.mobile` 的新 `google-services.json`。
  - 已验证：APK 内嵌 Expo 配置 `apiBaseUrl=https://api.leaif.com`、`allowInsecureHttp=false`；旧地址 `frp-fly.com` 在 APK 全部文件中 **0 处出现**。
  - 遗留小项：Android 启动器应用名仍是 prebuild 时代的「智能客服中心」（`app.json` 现为 Weflow），如需改名需重新 prebuild + 重建（不阻塞验收）。
- [ ] **E3. iOS 构建（如 A3 不延后）**：EAS preview 构建成功并安装。
- [x] **E4. 产物指向校验**：嵌入配置已指向生产/验收 HTTPS 地址 `https://api.leaif.com`；`allowInsecureHttp=false`，明文 HTTP 无泄漏。

## F. Push 专项（独立于主链验收）

> 主链已通的前提下单独验证；Push 是 invalidate signal，任何异常都必须能被 15 秒轮询兜底，两者分开记录。

- [ ] **F1. 设备注册**：A/B 真机登录后，Server2 `notification_devices` 出现对应安装记录与 Expo Push Token；注销/重装后旧记录失效处理正确。
- [ ] **F2. 指定客服 Push**：A 转给 B → B 真机收到 Push（通知体为联系人与状态，默认不含消息正文；符合通知预览设置）。
- [ ] **F3. 专业队列 Push**：转给专业队列 → 合法成员（A，非 B）收到 Push；B 不收到。
- [ ] **F4. 负责人新消息 Push**：人工处理中客户来新消息 → 仅负责人收到。
- [ ] **F5. Push 点击跳转**：点击 Push 打开对应会话并立即刷新到 Server2 真实状态（App 在前台时 Push 只触发刷新，不弹两条）。
- [ ] **F6. Push 丢失 → 轮询兜底**：禁用 App 通知权限（或后台杀通知）→ 新 Handoff 出现 → 前台 15 秒内 Inbox 自动出现该会话；后台不轮询、回前台立即刷新。
- [ ] **F7. 重复与丢失审计**：同一 Handoff 创建事件对每台设备最多一条 `notification_outbox`；投递失败/DeviceNotRegistered 在服务端可审计。
- [ ] **F8. 预览偏好**：通知预览设置（显示/隐藏/仅状态）在重装后仍按 Server2 已确认值生效。

## G. 真实微信通道端到端（产品级验收）

> 前置：A4、A7。此节是「真正产品验收」：微信客户 → Agent → Handoff → 手机人工 → 客户收到 → 结束 → Agent 接续。

- [ ] **G1. 客户入站**：微信客户发消息 → WeChat Channel Host 接收 → Core 生成 Conversation，Agent 正常回复客户（基线确认）。
- [ ] **G2. Agent 转人工**：触发转人工 → Mobile 出现结构化 Handoff（对应 D3/D4 全流程在真实客户上执行一遍）。
- [ ] **G3. 人工消息到达客户**：客服回复 → 微信客户真实收到人工消息，显示正常、顺序正确。
- [ ] **G4. 人工处理中客户追加**：客户在人工处理中继续发消息 → 客服侧实时可见（Push + 轮询），回复可继续。
- [ ] **G5. Human Finish → Agent 接续**：结束人工处理 → 客户再次发消息 → Agent 正确接续（受控上下文，见 D11 标准）。
- [ ] **G6. 转交途中真实客户追加**：转交确认期间客户发新消息 → 旧预览因 revision 冲突失效 → 刷新后重新确认转交（对应 C7 的真实通道版）。

## H. 跨端强制改派与一致性（Web Console ↔ Mobile）

> 前置：Console Web 管理台可用（`console`）。

- [ ] **H1. Web 强制改派**：Web Console 在 A 处理中强制把 Handoff 改派/结束 → A 手机**立即失去发送权限**、Composer 消失；若 A 有未发送草稿 → 本地草稿归档为只读（可查看/复制，不能发送）。
- [ ] **H2. 非负责人伪造请求**：B 用抓包工具以 A 的身份调用发送/转交/结束接口（或修改本地请求）→ Core 返回 `handoff_not_assignee` / revision 冲突；**界面禁用只是体验优化，服务端必须拒绝**。
- [ ] **H3. 幂等发送**：负责人用同一 `clientRequestId` 发送两次 → 客户只收到一条消息；`idempotency_key_reused` 语义正确。
- [ ] **H4. Token 失效**：A 改密/被禁用/远程注销后 → 立即无法调用业务接口（`token_expired` / `account_disabled`）；App 回到登录页，敏感数据清除。

## I. 离线 / unknown outcome / revision 冲突专项

- [ ] **I1. 离线只读**：A 断网打开会话 → 最近已查看会话可读（加密缓存、账号隔离）；发送、接手、转交、结束、建议生成全部禁用；恢复网络后自动解除。
- [ ] **I2. 离线草稿编辑**：离线 owner 可编辑本机加密草稿；草稿按 `accountId + conversationId + handoffId` 隔离，不进入未受保护备份。
- [ ] **I3. 发送结果未知（outcome_unknown）**：发送响应丢失（断网/超时）→ 本地保留原 `clientRequestId` 与 `expectedConversationRevision` → 重启 App 后先查询原请求 outcome，**不生成新 ID 重发**；查询期间禁止转交/结束/重复发送。
- [ ] **I4. revision 冲突**：他端（Web 或另一台手机）改变 ownership/Cycle → 本机草稿归档只读；发送闸门以 `baseConversationRevision` 为准，过期草稿必须「已检查最新内容」确认后才可发送。
- [ ] **I5. 缓存安全**：退出并清除本机数据 → 该账号草稿与离线缓存删除；切换账号 → 原账号草稿隐藏锁定，重新登录可恢复；App 后台隐私遮罩生效。
- [ ] **I6. 失败类型区分**：`retryable_failed / rejected / permission_lost / outcome_unknown` 显示不同可操作文案（`src/api/action-error-copy.ts`），不统一伪装成「网络错误」。

## J. 生产基础设施验收

> 前置：Core 以生产部署形态运行（systemd 单元：`deploy/systemd/weflow-core-*.service`），HTTPS 地址指向该实例。

- [ ] **J1. 三个 Worker 存活**：summary worker（异步 resolutionSummary）、transfer timeout worker（15 分钟 acceptBy 回收）、notification worker（outbox 投递）均按部署形态运行并写日志。
- [ ] **J2. 超时回收**：转给 B 后 B 不处理 → acceptBy 到点自动进入 fallback queue，A 不重新获得发送权，Agent 不恢复。
- [ ] **J3. Worker 重启恢复**：kill 任一 worker → systemd 拉起 → 未完成任务（outbox/总结/超时）继续处理，不丢单、不重复投递同一事件。
- [ ] **J4. Backlog 处理**：一次制造 ≥ 20 条 outbox（或人工会话积压）→ 投递器分批处理不卡死、不 OOM；积压水位可观察。
- [ ] **J5. 错误监控**：错误上报仅含脱敏技术信息（无聊天正文、联系人、Token、堆栈泄漏）；失败请求有可审计记录。
- [ ] **J6. 停机窗口**：Core 重启期间 Mobile 显示明确错误/重试状态，不崩溃、不丢本地草稿；恢复后自动续上。

---

## K. 出口条件（全部打勾才算完成）

| 区块 | 内容 | 状态 |
| --- | --- | --- |
| A | 前置环境（HTTPS 地址 / 真机 / 微信 / Push / 账号） | ☐ |
| B | 静态门禁（test / typecheck / lint / export / 配置守卫） | ☐ |
| C | Core 集成回归 8 场景 | ☐ |
| D | Android 真机主链 12 步 | ☐ |
| E | Release 构建与安装 | ☐ |
| F | Push 专项 8 项 | ☐ |
| G | 真实微信通道端到端 6 项 | ☐ |
| H | 跨端强制改派与一致性 4 项 | ☐ |
| I | 离线 / unknown outcome / revision 冲突 6 项 | ☐ |
| J | 生产基础设施 6 项 | ☐ |

**发布判定**：

- ✅ **全部 ☐ → ✓**：Mobile 0.7.0 完成，可发布。
- ⛔ **存在 ⛔ 环境阻塞项**：发布状态为「0.7.0 未完成」，`CHANGELOG.md` 与交接文档必须记录阻塞资源；解除阻塞后补测该区块，不允许整体跳过。
- 每次验收会话结束时，在本文档末尾追加一条 `### 验收记录（日期）`，写明：跑了哪些项、结果、环境变化、阻塞项。

### 验收记录（2026-08-12 建立）

- 本清单建立时基线：B1 24 文件 / 138 测试通过；B2、B3 通过；C 节 Server2 集成测试 8 场景此前已通过（2026-08-11 交接记录）。
- **2026-08-12 基础设施进度**：
  1. ✅ **A1 通过**：稳定 HTTPS 入口 `https://api.leaif.com` 上线并验证（见 A1 记录）。链路：公网 → VPS Caddy(Let's Encrypt) → frps :7000/28660 → 本机 frpc → Server2 :3100。
  2. ✅ 临时 cloudflared 入口验证后已停用。
  3. ⏳ **Android 真机未确认**（adb 已就绪，待用户插机 `adb devices`）；蜂窝网络访问 `https://api.leaif.com/health/live` 待用户实测。
  4. ✅ **0.7.0 Release APK 构建完成并验证**（2026-08-12 02:55，108MB；内嵌配置 apiBaseUrl=https://api.leaif.com、allowInsecureHttp=false；旧地址零残留）。
  5. ✅ **SakuraFrp 彻底清除**：定位为 Docker 容器 `natfrp-service`（镜像 natfrp.com/launcher，restart=always，bind mount /etc/natfrp）；已 `docker update --restart=no` + stop + rm + rmi。待用户执行最后一条 `sudo rm -rf /etc/natfrp` 清理残留目录。
  6. ⏳ **Android 真机连接待修复**：`lsusb` 无安卓设备（物理连接问题，换数据线/USB 口、开 USB 调试）；连接后 `adb devices` → `adb install app-release.apk` → D 主链。
  7. **D 主链进展（合成客户「验收客户·小测」）**：
     - ✅ D3 等待接手（Brief+Transcript+唯一主操作）；D4 接手（Server2 claimed）；D5 Brief 展示（含建议首句）；D6 人工回复（采用了建议首句，Server2 受理，send_state=unknown 属预期——合成客户无真实微信通道）；D10 结束人工处理（finished，异步 resolutionSummary 10 秒后生成，`server_rules_v1`）。
     - ✅ 转交超时回收 worker 实测运行：门锁 Handoff 转交 accept-b 后 15 分钟窗口到期自动进入 fallback queue（不回原客服、不恢复 Agent）。
     - ⛔ **切换账号 bug（已修复，待新 APK 验证）**：原 0.7.0 APK 的「切换账号」因 sign-out 链路无超时/无 finally 保护，弱网或存储异常时不跳登录页（根因：`src/auth/sign-out.ts` revoke/logout 裸 await 可 hang；`clear()` 无保护；`me.tsx` 静默吞错）。已修复：网络清理 5s 超时 + 导航移入 finally 必然执行 + 行内 loading + 最近登录快捷切换（≤5 用户名，不存 token）+ sync-store 切号重置。修复版 APK 构建中。

### 验收记录（2026-08-12 建立）— 附录：SakuraFrp 清除命令

```bash
# 需用户本机执行（root 权限）：
sudo pkill -f natfrp_service
sudo rm -rf /etc/natfrp
# 验证：ps aux | grep -i natfrp 无输出；ls /etc/natfrp 不存在
```

### 验收记录（2026-08-12）— Conversation UX 优化轮（Round A）

**范围**：Brief 三档折叠 / Suggestion 连续状态 / 转交说明可选并传递 / 联系人 Header 入口与历史 / 代码增量拆分 / 小项。Realtime 留待下轮。

**已完成并验证（两端门禁全绿）**：
- Server2：`transferReason` 改可选（zod + 服务层）；详情新增 `activeTransferNote`；收件箱新增 `transferNote`；legacy 转交补写 `states.reason`；`GET /conversations?contactId=` 联系人历史过滤。集成测试 11/11 通过（新增 3 条：无原因转交/留言传递/联系人过滤）。typecheck 通过。
- Client1：`HandoffBrief` 三档（collapsed/compact/expanded）+ 点击循环 + 滚动自动折叠（manual intent 优先）+ 键盘强制最小化 + 已读本地化（accountId+conversationId+cycleId）；`copilot-state` 拆 retrieving/generating + 显式 error 态 + SSE 流式文本渐进渲染；CopilotBar 单一连续容器 + 展开/收起 + 错误重试；采用建议写入 Composer（空则直接写入并聚焦，非空则 插入/替换/取消）；转交说明可选（placeholder「给下一位客服补充一句话…」）+ 目标客服 Brief 显示「转交留言」；Header 联系人入口（UserCircle）+ ContactSheet（资料+历史列表）+ 只读历史详情（无操作入口，关闭回原会话）；＋菜单收敛为 建议回复/转交处理；···菜单「Handoff 历史」升级为全屏审计 Sheet（cycles 全量）；Claim 轻触感 + Composer 淡入；Header 常态隐藏「实时同步」，仅离线时显示。
- 测试 26 文件 / 156 全过（新增 brief-read-state 6 条、重写 copilot-state 12 条）；lint/typecheck/web export 全绿。
- Server2 已知遗留（非本轮引入，交接文档已有记录）：kill-switch / media-degraded-turn / config 三个测试因历史脏改动（knowledge 模块）与环境配置失败，未触碰。

**§20 回归审查**：无新一级页面/Tab；Header 联系人 icon 为 ＋菜单项净替换；无技术状态暴露；确认次数不增（转交原因不再强制）；Sheet 关闭即回原会话并恢复 draft/scroll。

**待真机验证（新 APK 构建中）**：Brief 三档手感、Suggestion 流式连续性、转交留言可见性（§45 验收场景：leaif 转交带留言 → accept-b 在 Brief 看到）、联系人历史、只读历史返回原会话。

### 验收记录（2026-08-12）— Contact History / Media / Suggestion Completion 轮

**范围**：联系人数据库级完整历史（正式合同）/ 客户图片可靠加载（根因修复）/ Suggestion 微信草稿化（纯文本+质量）。

**根因与修复（已实证）**：
- **图片**：`GET /media/:id/content` 原仅放行 `status=ready`，而 ready 只能由视觉描述流程写入；本机无视觉模型 → 图片被置 `failed/vision_not_configured`（文件在磁盘）→ 永久 404。已修复：`ready|failed` 且文件存在即出图（兑现 dispatcher 注释"人工仍可查看原图"）；ENOENT→404；cache-control 改 no-store（配合客户端切号清内存缓存，杜绝跨账号缓存泄漏）。**真实数据验证：failed 状态真实微信图片现在返回 200 image/jpeg 4882B**。客户端新增 MediaImage（未就绪自动退避重试/失败重试/离线不请求/401 走既有事件），只读历史图片同链路。
- **联系人历史**：新增正式合同 `GET /api/v1/contacts/:contactId/conversations`（游标分页 {latestMessageAt, conversationId} + `conversations(contact_id)` 索引迁移 0039）；客户端 ContactSheet「查看全部历史」分页页。真实数据验证：返回含 resolved handoff 的真实历史。
- **Suggestion**：整理 prompt 强化（纯文本/1-3 句/不重复已确认信息/一次一步/禁 Markdown 前缀）；新增 `normalizeSuggestionText` 清洗层（9/9 单测）；Fast Path（reply 模式 + 结构化 Brief → 跳过 WeKnora 检索本地直生，4/4 集成测试，真实模型冒烟通过）；`hasStructuredBriefing` 上下文标志。

**20 条样本质量验收（真实 DeepSeek 模型）**：纯文本 20/20、短句 20/20、零 Markdown、零重复询问已确认信息（唯一反复询问项 = briefing 待确认的网关固件版本）；轻微机器腔（"已记录您的情况" 7/20）记为下轮 prompt 微调项。

**门禁**：Server2 283 通过（新增 media-content 4 + sanitizer 9 + fast path 1 + 联系人游标 1）；遗留 2 个失败（kill-switch/media-degraded）与 lint 27 项均为历史并行脏改动（conversation-events 实时事件脚手架）与环境问题，未触碰。Client1 156 通过、lint/typecheck/web export 全绿。服务已重建 dist 并重启（core/agent/ingestion 健康）。

**环境事实**：视觉描述模型未配置（无 VISION_API_KEY）——图片可看、自动描述缺位；suggestionV2 独立端点未实现（capability 旗标保持现状）；Realtime 事件总线已有并行脚手架（conversation-events），属下轮工作。

### 验收记录（2026-08-12）— 全栈最终体检

**发现并修复**：
- ⚠️→✅ **systemd 化引入的 WorkingDirectory bug**：服务化后 cwd 变 `$HOME`，相对路径 `FILE_STORAGE_ROOT=.data/files` 被解析到 `~/.data/files`（不存在）→ 媒体内容全部 `media_not_found`（此前裸进程时代正常）。修复：三个服务 unit 加 `WorkingDirectory=/home/leaif/Cococat/weflow-server`。修复后两张 failed 真实图片 200 image/jpeg（4411B/4882B）。
- ⚠️→✅ **集成测试残留**：fast-path 测试创建的 knowledge-fast 会话/Handoff 未被 afterAll 清理，污染收件箱。已按 FK 顺序清理，leaif 收件箱归零。

**体检全绿**：5 个 systemd 用户服务 active（frp-api/frp-web/weflow-core/agent/ingestion）；3100/3101/3102 健康；api.leaif.com + web.leaif.com 公网可达（证书至 2026-11-09）；Docker 容器全 healthy（unless-stopped）；Server1 ok、WeKnora up；capabilities 端点 12 键齐全（客户端独立获取，inbox 不带属正常设计）；登录正常；CPU powersave；磁盘 29%。

**基础设施升级（省电+保活）**：关键进程全部 systemd 用户服务化（Restart=always、OOMScoreAdjust=-500、登录自启）；显示器 10 分钟熄屏；合盖/空闲不挂起已三层确认；Docker 容器重启自动恢复。**J3（worker 重启恢复）部分达成**：systemd 自愈已落地，验收时可直接 kill 进程验证自动拉起。

**剩余验收项（环境就绪，待真机）**：新 APK `weflow-0.7.0-media.apk` 安装后的图片/联系人历史/建议链路；F Push（notification.devices 仍为空，需查手机注册）；G 真实微信通道（Server1 auth-token 可能过期需重登）。

---

### 验收记录（2026-08-12）— Client2 全会话访问 + 人工主动接管（Manual Takeover）

**业务模型（锁定）**：`AGENT_ACTIVE → 主动接管 → HUMAN_ACTIVE → 结束人工处理 → AGENT_ACTIVE`；`AGENT_ACTIVE → Agent 请求人工 → HANDOFF_PENDING → Claim → HUMAN_ACTIVE`；`TRANSFER_PENDING → Accept Transfer → HUMAN_ACTIVE`。UI 统一「接手处理」，Server2 command 语义精确（take-over / accept / accept-transfer 各自独立，审计不混淆）。

**服务端合同（weflow-server，向后兼容，无新迁移）**：
- `POST …/handoff/take-over`：summary 改可选（=takeoverReason）+ 新增 `sourceConversationRevision`；audit metadata `takeoverType:"manual"` + `sourceConversationRevision`；成功补发 `ownership_changed` 事件；pending 上调用 → 409 `invalid_handoff_transition`。
- `GET /api/v1/conversations`：新增 `?scope=attention|mine|others|all`（服务端计算排序）+ `?before/limit` 游标分页 + 每项 `permissions{couldView,canManualTakeover,canReply,canTransfer,canFinish}`；handoff 对象新增 `agentPaused`。`all` = 真正全部可见会话（留给未来搜索/统计/导出）。
- `GET /api/v1/console/capabilities` → `{conversationPermissions:true}`（capability 门控；开启后权限字段缺失即只读，fail-safe）。
- **ownership advisory lock**（`pg_advisory_xact_lock('weflow:ownership:<conversationId>')`）：handoff transition / mobile claim·transfer·finish·reject / Agent 落库 ×2 / 人工回复，共 7 事务取锁——**接管与 Agent 最终外发争同一把锁，双发从概率问题变成结构上不可能**。
- 测试抓到并修复真实生产 bug：scope=others 的 SQL 三值逻辑（`NOT(NULL 条件)` 为 NULL）导致无 handoff 的 AGENT_ACTIVE 会话被全部漏掉 → mine/attention 条件加 `isNotNull(status)` 守卫。
- 集成测试 `tests/manual-takeover-v2.integration.test.ts` **12/12 通过**：双人并发接管恰一人成功、锁不变式（并发+确定性）、命令边界（pending 上 take-over 409 / agent-active 上 accept 409）、接管压制（turn→suppressed_handoff、pending 消息→cancelled_handoff）、能看≠能回复（无接管 403 / 接管后 202）、幂等重放、ownership_changed 事件、scope×4 + permissions、游标分页、capabilities 端点。

**Console（Weflow Console）**：capability 门 → 三区列表（需要处理/我处理中/全部会话，Core scope 驱动 + 分区「加载更多」）；AGENT_ACTIVE 详情页接管条（说明文案 + 一键接管，无二次确认）；接管成功 180ms 状态转场 + Composer 淡入（不整页重载）；409 竞争失败静默刷新为「王工正在处理」只读；按钮全部 permissions 驱动（fail-safe）；agent-active 不显示 Composer（服务端本就 403，UI 对齐）；Inspector 当前任务显示「Agent 已暂停自动回复」；历史视图升级（MediaImage 渲染图片、游标分页、只读横幅）；⌘/Ctrl+Shift+H 快捷键（eligible 时接管）。`pnpm check`（boundary+typecheck+build）全绿。

**GUI 实测（web.leaif.com，leaif 账号，1280→1600 视口）**：
- ✅ T1 三区列表（需要处理 3 / 我处理中 0 / 全部会话 7，计数与分区正确，两次独立观察）
- ✅ T2 Agent 处理中会话 → 接管条（「Agent 正在处理此会话 / 接管后，Agent 将暂停回复，由你负责当前会话。」+ 接管处理按钮），无 Composer
- ✅ T3 点击接管 → 会话移入「我处理中」、Composer 淡入、Inspector「我处理中 + Agent 已暂停自动回复」、权限菜单出现转交处理/结束人工处理
- ✅ T4 结束人工处理 → 会话回「全部会话」标「已完成」；DB 确认 `resolved / agent_paused=false`
- ⛔ T5 历史只读视图深度导航、T6 快捷键：**运行时阻塞**（IAB 点击管道持续损坏：约 10 次按钮点击可解析但不可执行；已按技能规则停止并如实记录，不伪造成功）。逻辑已过 type-check/build + 代码审查，需后续补测。
- 截图工件：`/home/leaif/Cococat/gui-test-screenshots/{t1_sections,t2_takeover_bar,t3_after_takeover}.png`（模型不支持图像输入，视觉核对需用户查看工件）。

**本轮 UX 发现（未修，待决策）**：
1. 容器宽 ≤1180px 时 Inspector 自动打开为浮层 + backdrop，会盖住接管条——用户需先关 Inspector 再接管（两步）。既有 Inspector 行为，非本轮引入。
2. 队列列无滚动规则，长列表底部行被裁切不可达（本次 10 行即有 2 行不可见）；可用搜索绕行。建议下轮给 `.wf-queue` 加 `overflow-y: auto`。
3. Rior 会话（wxid_un3qh1w5bz2y21）仍 pending 等待接手（L3 watchdog 观察项）；本轮接管+结束的是 knowledge-fast-1786483131928-1855116（验收数据，状态已归位）。

### 验收记录（2026-08-12）— Client1 mobile 人工主动接管（Manual Takeover）

**能力**：Inbox 第三档「Agent 处理中」列出服务端判定可主动接管的 AGENT_ACTIVE 会话（`GET /api/v1/conversations?scope=others` + 过滤 handoff===null，Bearer 认证），详情页底部「接管处理」一键接管（无二次确认），成功后进入既有 HUMAN_ACTIVE 链路（Composer/转交/结束/建议零改动）。

**Server2（向后兼容）**：
- `mobileHandoffCapabilities` 加 `mobileManualTakeover: true`
- `MobileOperation`/`outcomeQuery` 加 `take_over`；`eventTypeFor` 映射 `manual_taken_over`；`transition()` 事件补写 `outcomeStatus:"succeeded"` + `responseSnapshot`（此前 legacy 事件不写，outcome 查询会误判 failed）
- 集成测试 15/15 全过（新增：Bearer take-over 201、双人并发恰一人成功、outcome take_over succeeded、capabilities 键）

**Client1**：capabilities flag（legacy false）；`listTakeoverableConversations`/`takeOverHandoff` API 封装（幂等 clientRequestId、outcome 兜底）；sync-store 并入 takeoverable 快照（30s 轮询同周期）；Inbox 三档（capability 门控）；详情页 `mode:"takeover"` + ActionPanel「接管处理」+ `takeOver()`（409 → 刷新为服务端事实，成功 → 拉取权威 handoff）；新增 vitest.config.ts（`@/` 别名与 tsconfig 对齐）；单测 164/164 全过（+ui-state takeover 4 例、api 映射/请求体 4 例）；lint/typecheck 全绿。

**E2E 验证（Bearer 真实链路）**：capabilities 含 mobileManualTakeover ✓；scope=others 返回 AGENT_ACTIVE（canManualTakeover=true）✓；take-over → in_progress/agentPaused ✓；outcome take_over → succeeded ✓；resolve 恢复（resolved/agentPaused=false）✓。

**真机 GUI 验收**：⛔ 环境阻塞（无数据线）；APK 未重建（版本流程未触发），待真机就绪后补：三档切换、接管按钮、接管后 Composer 出现。

**文档**：mobile-spec.md 修订「无有效 Handoff 的会话只读」条款；CHANGELOG Unreleased 增条目；weflow-server/docs/manual-takeover.md 含 Mobile 合同。

**环境备注**：本轮期间系统级旧 unit（`weflow-server2-*`）第 4 次抢占 3100 导致旧 dist 短暂服务——已竞速夺回；**该 sudo 停用命令仍未执行**（`sudo systemctl disable --now weflow-server2-core weflow-server2-agent-worker weflow-server2-ingestion-worker`），每次 user 服务重启都会复发。

### 验收记录（2026-08-12）— 客服体验修复轮（走查发现 → 全部修复）

**走查方法**：以客服视角代码走查 + Expo web 版浏览器实测（CORS 修复后完整跑通）。

**修复清单（全部完成并验证）**：
- **P0-1 app.json apiBaseUrl**：SakuraFrp 死地址（frp-fly.com:28660）→ `https://api.leaif.com`。旧 APK 内嵌地址无法从 Hermes 字节码确认，已重打 APK 兜底。
- **P1-1 操作后列表同步**：claim/takeOver/finish 三处成功路径加 `notifyConversationRefresh()`。实测：接管后返回列表「我处理中 1→2 / Agent 处理中 1→0」即时更新 ✓。
- **P1-2 Agent 档未读可见性**：未读徽标（红点数字）+「客户有新消息」文案。实测：会话行显示未读 4 ✓。服务端 push 经用户决策**不做**（避免通知洪泛，客户端展示足够）。
- **P1-3 Server2 CORS**：白名单化（`CORS_ORIGINS` 环境变量，默认不开放）。实测三态：白名单 origin 有头 / 非白名单无头 / OPTIONS 预检 204 完整头 ✓。web 版 mobile 登录因此打通。
- **P2-1 「可接管」提示**：Agent 档行 attention 文案「可接管 · …」。实测 ✓。
- **P2-2 搜索跨分区**：搜索合并可接管+任务列表。实测：等待接手档搜到我处理中档会话 ✓。
- **P2-3 接管 Composer 淡入**：现有 180ms `useEffect` 机制自动覆盖（mode→reply 触发），无需新代码。实测接管后 Composer 出现 ✓。
- **P2-4 web 会话持久性**：评估为安全设计（token 不入 localStorage），**不改**；实测确认整页刷新即掉登录（web 调试预期行为）。

**实测截图**：`gui-test-screenshots/m1_mine_after_takeover.png`（接管后我处理中档）。

**APK**：重打中（新地址 + 全部新功能：三档/接管/未读/列表同步）。

### 验收记录（2026-08-12）— 登录页视觉重设计

**方案（高明高雅）**：用户提供 `blue_app_background.svg`（1440×2560 深蓝渐变+柔光+波浪+暗角）→ 浏览器渲染保真转 PNG（react-native-svg 不支持 feGaussianBlur 滤镜，故用 Chromium 截图转换，2.69MB/1440×2560 全保真）→ 登录页改为全屏背景 + 半透明白玻璃卡片（rgba 白 13% 底/白 32% 细边/圆角 24）+ 白字输入（16% 白底）+ 白色登录按钮深蓝字（#1F5FAF 与背景同色系）。

**品牌低调措施**：登录页 Weflow / 人工接管 / logo 图形全部移除，仅剩账号密码表单。DOM 实测确认无品牌元素。工作台内部「AGENT ↔ HUMAN」语义标签保留（非品牌）。

**验证**：typecheck/lint 全绿；web 版实测：新登录页渲染、登录链路正常进入 Inbox。

**说明**：app 桌面图标（icon.png）未改动（删除会导致系统默认图标）；如需更换桌面图标可另行提供。

### 验收记录（2026-08-13）— 登录页 Quiet Editorial 重构（frontend-design + taste-design skill 驱动）

**Skill**：`anthropics/skills@frontend-design`（769K 安装）+ `leonxlnx/taste-skill@design-taste-frontend`（use 获取 1213 行准则）；二者已装/引用。

**Design Read**：内部客服工具登录页 for 员工，calm-editorial 语言，极简空间构图 + 系统字体 + 极淡冷蓝 SVG 大气层（Dials: Variance 5 / Motion 2 / Density 3）。

**实施**：
- `src/ui/login-atmosphere.tsx`：独立 SVG 空间层（SvgXml，无 filter——RN SVG 不支持 feGaussianBlur，用低透明度渐变模拟柔光；左上大椭圆露角 + 细曲线 + 2–3 小几何 + 局部点阵；light/dark 双版本，dark 用深蓝调更低透明度）；进入 320ms 极轻 opacity reveal（respect useReducedMotion）
- `app/index.tsx` 重构：浅冷白画布（主题 canvas）+ 无卡片表单直落画布；桌面右对齐（宽 360 / 右侧 12% 留白，左侧 63% 空间）；窄屏顶部留白 + 表单主体；无标题（B 方案）；label 在上、输入 48px/radius 10/近透明/focus 主色；中等宽度深石墨按钮「登录 →」；错误 inline；loading「登录中…」+ spinner；180ms 进入淡入；密码框 Enter 提交（onSubmitEditing）；focus 状态、aria、Tab 顺序

**浏览器验收**（web.leaif 19006，真实 Server2）：
- ✅ 1440×900 / 1920×1080 / 390×844 三尺寸：无品牌、无卡片、无 Logo、「登录 →」按钮、表单正确渲染
- ✅ Enter 提交 + 按钮登录均成功进入 Inbox（中途一次失败为系统级旧 unit 抢端口跑旧 dist（无 CORS）所致，夺回后恢复——**该 sudo 停用命令仍待执行**）
- ⚠️ Dark 模式：web 无法模拟 prefers-color-scheme + IAB modal 交互受阻（工具限制）——dark 分支经代码审查确认（isDark → DARK SVG + darkColors + 深色按钮对比）；真机系统深色为最终验收
- ⚠️ 截图管道超时（IAB 工具），视觉工件缺失——DOM 快照为代码层证据
- typecheck / lint / 164 测试全绿

**Skill 使用注记**：taste-skill 的 use 输出含 React/Tailwind 栈建议，本项目为 React Native（StyleSheet），取其设计准则弃其栈；「登录 →」单行 CTA、无 eyebrow、单 accent、无 shadow 等规则均已遵守。

### 验收记录（2026-08-13）— 内部工作台 Quiet-Operational 视觉优化（frontend-design/taste-design skill 驱动）

**Design Read**：内部客服工作台 for 员工，quiet-operational 语言——信息架构不动，收敛「一个 accent、一套 radius 规则、一套按压反馈、统一状态语义」。

**P0 一致性收敛**：radius 规则表落地（主按钮/输入 12、sheet 20、chip/徽标 8、气泡 17 保留）——主按钮 8 档圆角全部收敛；menu/profile/response/modal sheet 统一 20；背板统一 rgba(0,0,0,0.32)；页头统一（notification-settings 70+paper+1px → 52 canvas 无边框）；Inbox title 27→22；pressed 统一（列表行 subtle 背景、按钮 opacity 0.8）；spinner 统一 colors.blue；错误态统一（会话详情补「重新加载」）；硬编码色 10+ 处替换为语义色（#777→muted、气泡时间戳主题化、新消息圆点 primary）；字号最小化（8/9→10）。

**P1 暗色对比度（WCAG AA 复算）**：darkColors.onPrimary → #101318，一处 theme 改动 + 6 处 white→onPrimary 引用修正：
- dark primary #6F98F5 × #101318 = **6.74:1** ✓（原 2.81:1 白字）
- dark orange #E9A24C × #101318 = **8.73:1** ✓（原 2.16:1）
- light primary #315B8F × #FFFFFF = **6.91:1** ✓
- 图片 overlay（media-viewer/imageHintText）保留白字（浮层语义，主题无关）

**P2 状态体系化**：headerStatus 状态分色（等待接手/转交=orange、我处理中=primary、其余 muted——文字为主颜色为辅）；orange 语义收敛；chip 圆角统一 8（三套 6/8/9 → 8）。

**P3 加载/离线**：会话详情初始加载 4 行静态气泡骨架（无动画）+ 错误态「重新加载」（reloadKey 触发器）；**Inbox 离线态**（sync-store offline 字段，请求失败置位/成功清除/登录失效除外；横幅「离线 · 显示最近记录」与详情页同文案）。

**P4 死代码清理**：删除 workspace-header / work-status-pill / context-sheet / knowledge/markdown 四个整文件 + [id].tsx 20 个死样式（复查 0 引用后删除）。

**验收**：typecheck / lint / 164 测试全绿；浏览器实测（390×844 窄屏 + 桌面）：登录→Inbox 三档→详情页（headerStatus/Brief 折叠/反馈按钮/加载更早）→me 页，全部正常渲染无回归；离线态 GUI 验证跳过（需中断服务，代码审查 + sync-store 逻辑确认）。

**说明**：并行 session 曾于 00:42 修改 [id].tsx（VoiceBubble 集成）与 media 模块——本轮改动与其共存，typecheck 通过；此后并行无新动作。

### 验收记录（2026-08-13）— Inbox 单列表 + 左滑 + 头像 + 体验收敛

**合并单列表**：三档 segmented 删除 → SectionList 三组（需要处理 N / 我处理中 N / Agent 处理中 N，顺序即优先级、颜色圆点区分）；头部仅「人工接管」；空态「暂无待处理」。实测：登录后节头计数正确、待处理/我处理中分区正确。

**左滑操作**（ReanimatedSwipeable，RNGH 2.32 已装；按状态 2 动作）：等待接手→接手+隐藏；我处理中→交回 Agent（导航详情 ?finish=1 自动打开结束确认）+隐藏；Agent 处理中→接管+隐藏。隐藏走 visibility 端点（Server2 已就绪，客户端补齐封装）；接手带 handoffRevision 走完整 mobile 路径；接管幂等 UUID。web 验收：动作按钮渲染正确（web 手势降级，真机滑动为准）。

**客服头像（全栈）**：Server2 迁移 0041（users.avatar_file_id → file_storage.files）+ POST /api/v1/auth/avatar（@fastify/multipart 注册、1MB、jpeg/png/webp）+ GET /api/v1/users/:userId/avatar（受限流式、no-store）+ /me 与 login 投影 avatarUrl；集成测试 3/3（上传→读取字节一致/401/404/类型 400）。Client1：expo-image-picker 安装、me 页点击更换（裁剪 1:1）、Inbox/me 头像显示（expo-image + Bearer）。curl 实测 /me 返回 avatarUrl:null ✓。

**按钮布局**：panelButton flex:1（单按钮占满、双按钮等宽）。

**自动定位**：数据就绪后 50ms 兜底 scrollToEnd + 切会话重置定位状态（maintainVisibleContentPosition 竞争修复）。

**门禁**：Server2 typecheck/lint + avatar 测试 3/3；Client1 typecheck/lint/164 测试全绿。

**已知限制**：左滑手势 web 上不可滑动（RNGH web 降级为按钮可见）；真机验收待装 APK。

### 验收记录（2026-08-13）— 微信式工作台（全部会话 + 联系人 + 折叠 + 滑动双页）

**服务端**：新增 `GET /api/v1/contacts`（联系人聚合最近可见会话 + 游标分页，Bearer）；`scope=all` 复用（含普通会话）。curl 实测：contacts 5 项 + nextCursor、scope=all 含各状态会话。

**客户端**：sync-store 重构为 scope=all 单一源（原 inbox+takeoverable 双源移除，capabilities 独立拉取）；首页横向 paging ScrollView 双页（会话 | 联系人 tab 点按+滑动切换，零新依赖）；会话分组折叠条（色点+计数+箭头，无文字）；卡片分色（橙 Wash/蓝 Wash/无色）+ 状态角点；左滑动作按状态（普通会话仅隐藏）；联系人页复用 UserAvatar + 点击打开 ContactSheet。浏览器实测（390×844）：双 tab、全部会话可见（含 Leaif 与普通会话 quiet 组 5 个）、折叠条计数 3/3/5、联系人页带头像与最近消息、分组顺序 need→mine→quiet。

**门禁**：Server2 typecheck/lint 通过；Client1 typecheck/lint/164 测试全绿。contacts 集成测试未写（curl 实测替代——分页字段已验证，正式集成测试记入下轮）。

**已知限制**：首页 100 条上限无「加载更多」（数据量小，记录）；web 端左右滑动为 ScrollView 原生行为（真机为准）。

### 验收记录（2026-08-13）— Client2 客户服务页重点优化

**8 项逐条**：① 三区折叠（section 头按钮化 + ▾/▸ + aria-expanded，加载更多随展开显隐）；② 等待时长对齐（`.wf-wait` nowrap + tabular-nums，移除等宽字体对 CJK 的误导）；③ 进入会话无条件滚底（保留 messageId 锚点定位）；⑤ 顶部「N 个当前队列会话」副行移除；⑥ thread 内「为什么需要人工/已确认/仍需确认」Brief 块整体删除（Inspector brief 视图全量承载；初次点击会话 Inspector 自动打开、可关闭）；⑦ 行名 ellipsis 截断 + 行字体统一；⑧ 比例均衡（队列列 clamp 220-280、Inspector 320px、消息区 max-width 960 居中）。

**实测（web.leaif.com/conversations）**：头部仅标题+刷新；三区折叠按钮（需要处理 1/我处理中 2/全部会话 8）expanded 正确；时间文本统一（6 小时 29 分/15 小时 2 分）；thread 无 Brief 块。`pnpm check` 全绿。功能逻辑（接管/加载更多/搜索/SSE）未动。
