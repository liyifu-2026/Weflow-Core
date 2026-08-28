# 客服业务跑通工程图（Go-Live Workmap）

日期：2026-08-24
状态：工作图 v1（待 owner 确认决策点后开始执行）
目标：微信通道 + Console 工作台 + Mobile 人工介入 + WeKnora 知识 + AI 员工分配客户 + 远程上线（leaif.com）

---

## 0. 现状快照（侦察结论）

### 本机（Windows）
| 资产 | 状态 |
|---|---|
| `We/weflow`（平台核心） | Core API(3100)/agent-worker/ingestion-worker/console/weflowctl 代码齐；测试齐 |
| `We/weflow/runtimes/channel-host-wechat` | 微信 4.x 自动化通道主机（Python/wechatauto），**已复制但未入库** |
| `We/weflow-solutions`（customer-support） | support-web **仅 V1**（ConversationsView+PromptManager）；2 插件；BFF；artifacts 里 mobile.tgz 是 18B 空壳；manifest 假 digest |
| 旧树 `Desktop/wxbot` | channel-host-wechat 旧版、**support-web V2 工作台 41 文件**（AiEmployees/KnowledgeV2/PoliciesV2/CoachV2(影子)/OverviewV2）、**apps/mobile 完整 Expo RN**、旧 console（新 ExtensionHost 架构） |
| 旧树 `Desktop/wxbot/wechatbot-new` | 老 Python 微信 bot（CoreMemory、emojis 九分类、prompts 角色） |
| Docker | 本机运行中：weflow-core-postgres/redis、**WeKnora-app + WeKnora-frontend**、ZhiNanKB-*（旧） |
| `weflow/core/.env` | DeepSeek/WeKnora/MiMo keys 已配；CHANNEL_HOST_BASE_URL=127.0.0.1:43123 |

### 服务器 38.22.235.27（Debian 12，2C/1.9GB/30G，无 docker）
| 资产 | 状态 |
|---|---|
| frps | 运行中：bindPort 7000，`auth.token=3bd8e3343e75ae5f783a7855843fb0d4`，`allowPorts=[28660..28661]`；当前 **0 个 frpc 客户端连接** |
| caddy | 运行中：`api.leaif.com→127.0.0.1:28660`；`web.leaif.com`（/api→28660，其余→28661）；`kb.leaif.com` 暂缓（respond 占位） |
| 其他 | 宝塔面板 8889、MySQL 3306 对公网、root 密码登录 |

### 结论
- 服务器只做「caddy 反代 + frps 中转」，**真实服务跑在本机 Windows**（微信自动化只能跑 Windows）。
- 当前 `api.leaif.com` 502 = 本机没有 frpc 连服务器。
- 旧 `Temp/karry/frpc.toml` token 与服务器不符（`token_leaif_ssh`）且 remotePort 8092 不在 allowPorts —— 已失效，需重写。

---

## 1. 目标部署拓扑

```text
[微信客户端 + channel-host-wechat(43123)]      (本机 Windows，必须)
        │  channel 契约
[Core API 3100 + agent-worker + ingestion-worker]  (本机)
        │
[Console 5173] ── frpc(28661) ──► frps(服务器) ──► caddy ──► https://web.leaif.com
        │
[Core API 3100] ── frpc(28660) ──► frps(服务器) ──► caddy ──► https://api.leaif.com
        │
[WeKnora 8080(本机 docker)] ── (kb.leaif.com 需 frp 新端口 + 认证方案)
        │
[Mobile Expo APK] ── https://api.leaif.com（账号与 console 通用：同一 Core identity）
```

---

## 2. 补充遗漏点（原 11 条之外）

1. **服务器安全**：root 密码已出现在对话中 → 改密或换密钥登录；MySQL 3306 对公网暴露 → 绑 127.0.0.1 或防火墙；宝塔 8889 评估是否保留。
2. **frpc 重写**：token 对齐服务器 `3bd8e334...`；remotePort 必须用 28660/28661；做成系统服务/计划任务自启（本机重启后隧道要自动恢复）。
3. **kb.leaif.com**：用户要求"只写配置界面，WeKnora 有前端" → 需要决策是否开放 kb 子域（服务器 frps allowPorts 需扩一个端口；WeKnora 无用户认证，caddy 备注里已写明风险）。
4. **微信自动化风险与账号隔离**：wechatauto 是 UI/DB 自动化，有封号与窗口抢占风险；多账号需在 channel host 层用 `WECHAT_ACCOUNT` 分实例 + 事件带 `account` 字段，Core 侧按 `(account, contact)` 建会话隔离（回应用户第 9 条）。
5. **建议回复删除范围**：Core `knowledge/interface/http-routes.ts` 的 `/suggestion` 端点、`client-knowledge-service` 的 collectKnowledgeSuggestion/buildReplySuggestion、V2 工作台对应 UI，全部删除（含 sanitizer 与测试）。
6. **表情包 [表情包]xxxx**：channel host 已输出 `[动画表情]` 占位；升级为「多态小模型识别含义 → `[表情包]开心`」。旧树 `wechatbot-new/emojis` 有九分类素材可先做规则映射，模型识别作为增量。
7. **移动端构建与发布**：mobile 是 Expo RN。选项：EAS 云构建（需 Expo 账号）或本地 `eas build --local`/`npx expo run:android` 出 APK。`apiBaseUrl=https://api.leaif.com` 已内置。
8. **拍一拍**：微信「拍一拍」在 channel host 侧需捕获系统消息并映射为事件 kind=pat；工作台与 mobile 显示"对方拍了拍你"。
9. **群聊引用/@**：Core 消息需要支持 `replyTo`（引用）与 `mention` 字段；channel host 从微信 XML 解析 quote/at；出站由 host 合成微信 XML 发送。契约变更要走 ADR。
10. **插件资产托管**：ExtensionHost 动态 import 需要 `/solution-assets` 静态托管（旧 console 有此代理）；新 console 目前没有。
11. **记忆模块**：用户认为"已插件化"——实际 `core/modules/memory` 仍是内置模块（未注册 runtime kernel plugin）。需决策：保持内置（满足"能用"）还是下沉为 Solution 插件（满足"插件化"）。
12. **npm 发布**：`@weflow/*` 若发布 public 需要 npmjs 账号登录（会问用户）；备选 scope 名或私有源。
13. **可 npm 插件化的候选**（回应用户第 7 条）：contracts、plugin-sdk、solution-sdk、admin-sdk、ui、customer-support-strategy、product-troubleshooting、support-web（dist 静态包）、mobile（Expo OTA update 走 EAS，不走 npm）。
14. **运维**：`weflow-ops` 的 backup.sh/watchdog.sh 引用的服务器路径（/home/leaif/Cococat）已不存在——服务器疑似重建过；上线后需重写 watchdog（本机侧）+ 服务器 frp/caddy 健康监控。
15. **数据回填**：微信老会话若需迁移（旧 wxbot .data sqlite / ZhiNanKB 数据），做一次性导入脚本；不做则从零开始。

---

## 3. 决策点（需 owner 拍板后才可执行对应节点）

| # | 问题 | 决策（2026-08-24 拍板） |
|---|---|---|
| D1 | npmjs 账号 | ✅ owner 提供 granular token（已保存本机 `.npmrc` 外，不入库） |
| D2 | Mobile 发布方式 | ✅ 本地构建 APK（eas build --local / expo run:android） |
| D3 | kb.leaif.com | ✅ 开放：WeKnora 自带用户认证 + Core 已有 knora-bridge 免密交换；扩 frp 端口 28662 + caddy 反代 |
| D4 | 服务器 root 密码 | ✅ 不改密，凭据保存本机 `scripts/.server-credentials.txt`（owner 自担风险） |
| D5 | 微信账号 | ✅ 直接多账号：channel host 分实例 + Core (account, contact) 隔离 |
| D6 | 记忆模块 | ✅ 本次插件化下沉：MEMORY_CAPABILITY 进 RuntimeKernel |
| D7 | 建议回复 | ✅ 保留 Core 接口 + 关闭工作台/mobile UI 入口 |

---

## 4. 工作图（Phase → Node → Prompt）

依赖：Phase 0 → 1 → 2 → 3 → 4 → 5。Phase 1 的 N1.1/N1.2 与 Phase 2 可并行。

### Phase 0：安全与基线（半天）
```
N0.1 服务器安全加固 → N0.2 基线快照（git 提交 + 双仓打包脚本）
```
- **N0.1 prompt**：SSH 到 38.22.235.27：把 root 密码改为强随机值并写到本机 `.ssh/weflow-server.pw`（或配置 SSH 公钥免密）；MySQL 配置 `bind-address=127.0.0.1` 并重启；检查宝塔是否被使用，未使用则 `systemctl stop/disable bt`；`ufw` 或 firewalld 只放行 22/80/443/7000。输出改动清单。
- **N0.2 prompt**：在 `We/weflow` 与 `We/weflow-solutions` 分别做当前状态基线：`git status` 归类未提交文件，把 `runtimes/channel-host-wechat` 以 `.gitignore` 正确方式入库（排除 .data/.venv/image_keys.json/日志）；提交前确认 `core/.env`、API key 不入库。输出双仓 commit 清单。

### Phase 1：平台能力（Core/Channel）
```
N1.1 通道契约:channel.wechat+多账号 → N1.4 表情包文本化
N1.2 channel-host 入库与运行脚本     → N1.3 微信四类媒体收发验证
N1.5 删除建议回复                     N1.6 群聊引用/@(契约 ADR)
N1.7 AI 员工绑定客户（execution profile 分配）
N1.8 记忆模块决策落地（按 D6）
```
- **N1.1 prompt**：在 `weflow/core` 实现多微信账号隔离：channel 契约的 ConversationEvent 增加 `account` 字段（或复用 channelType 组合键）；`ingest-channel-events` 按 `(account, contactId)` 归并会话；`http-channel-provider` schema 同步；补集成测试（两个账号同一 wxid 不同 account 不得串会话）。参照 `core/AGENTS.md` 第 6 条——契约变更先写 ADR 到 `core/docs/adr/`。
- **N1.2 prompt**：把 `weflow/runtimes/channel-host-wechat` 整理入库：确认 `run.ps1` 可一键启动（uv 装依赖、43123 起 http_host、token 文件路径明确）；README 补「本机启动 + frpc 联动」说明；跑通 `python -m channel_host.main` 自检。
- **N1.3 prompt**：端到端验证微信四类消息：文字/图片/语音(SILK→MP3→ASR)/文件，从 channel host 事件 → Core ingest → 媒体 worker → 出站回复。用真实微信发一条测试消息，记录全链路日志与耗时；修复断点。
- **N1.4 prompt**：表情包文本化：channel host 对 emotion 消息产出 `[表情包]<含义>` 文本事件（先复用 `wechatbot-new/emojis` 九分类做 UIA 名称→含义映射）；Core 不再为 emotion 渲染媒体截图；support-web/mobile 渲染纯文本。多态小模型识别留增量接口（`EMOTION_CAPTION_MODEL` 配置项，默认关闭）。
- **N1.5 prompt**：删除智能回复/建议回复：Core 移除 `/api/v1/conversations/:id/suggestion` 路由、collectKnowledgeSuggestion、buildReplySuggestion、suggestion-sanitizer 及其测试；确保知识检索（retrieve_knowledge 工具）不受影响；跑 `pnpm typecheck && pnpm test`。
- **N1.6 prompt**：群聊能力契约：ADR 定义 Message 增加 `replyTo`、`mention` 字段（inbound 解析微信 XML 的引用与 @；outbound 由 channel host 合成）；Core `create-manual-reply` 与 agent 出站支持携带；补契约测试。注意 AGENTS.md「不修改既有 wire shape 除非 ADR」。
- **N1.7 prompt**：AI 员工分配客户：扩展 `execution_profiles` 增加 `agentName/avatar/promptRef` 字段（或新表 `ai_employees` + `ai_employee_bindings(contactId)`）；Agent Turn 入队时按绑定关系选择 profile；Console/Solution 提供「创建 AI 员工 → 编辑 prompt → 绑定客户」最小闭环；参照旧树 AiEmployeesView/AiEmployeeBindingsView 迁移。
- **N1.8 prompt**：按 D6 执行：若保持内置——给 memory 模块加启动日志与文档说明，标记待插件化；若插件化——把 memory capture/recall 抽象为 `MEMORY_PLUGIN` 能力 token 注册进 RuntimeKernel，`agent-worker` 改为从 kernel 获取。输出决策记录。

### Phase 2：Console 平台壳（weflow）
```
N2.1 ExtensionHost 新架构(异步 mount+/solution-assets) → N2.2 插件管理极简化(npm registry+自动升级)
N2.3 影子模式隐藏(隐藏页)
```
- **N2.1 prompt**：把旧树 `wxbot/weflow/console/src/weflow/extensions/{ExtensionHostView.vue,extension-store.ts}` 的新架构移植到 `weflow/apps/console`：`mount` 返回 `{unmount,navigate}` 契约、catch-all extensionHost 路由、`/solution-assets` 静态代理（后端同时提供 assets 路由，从 Solution Pack 解包目录 serve）；替换现有 ExtensionHost.vue 并兼容现有 `mount(container)` 形式。跑 console typecheck/build。
- **N2.2 prompt**：插件管理极简化：`SolutionsView.vue` 收敛为「已安装列表 + 版本 + 一键更新 + 卸载」；实现 npm registry 拉取（`npm view @weflow/<pkg>` 查最新版本 → 下载 tgz → 校验 digest → 解包安装 → 触发激活）；更新 `weflowctl` 命令对齐。注意保持 solution-pack 签名校验不变。
- **N2.3 prompt**：把「影子验证/教练」（CoachV2、PoliciesV2 中的影子区块）从主导航移除，收入 Console 的「高级/实验」隐藏页（仅 admin 可见）。

### Phase 3：业务 Solution（weflow-solutions）
```
N3.1 support-web V2 迁移(41文件) → N3.2 删除建议回复 UI → N3.3 微信客户端式工作台+隐藏页 → N3.4 WeKnora 配置 Solution
N3.5 mobile 迁移+拍一拍/上传 → N3.6 npm 发布(D1)
```
- **N3.1 prompt**：把旧树 `wxbot/weflow-solution-customer-support/apps/support-web/src` 全部迁入 `We/weflow-solutions/solutions/customer-support/apps/support-web/src`（替换 V1），保留 entry `mount` 契约；清理旧 `resources/scripts` 不需要的；`pnpm build` 产出 `dist/support-console.js`；在 `solution.manifest.json` 用**真实 digest** 更新 artifacts（用 `scripts/verify-solution.mjs` 校验通过）。
- **N3.2 prompt**：在 V2 工作台删除建议回复相关 UI（若存在）：回复起草/建议入口、suggestion 组件与 store 引用；确保知识检索入口保留。
- **N3.3 prompt**：ConversationsV2 按微信客户端简化：会话列表=头像+昵称+摘要+未读，聊天窗=气泡+输入栏（表情/图片/文件/语音按钮），引用与@ 支持；「更多」收进隐藏页（策略、教练、知识库管理、AI 员工等）；拍一拍与 `[表情包]xxx` 渲染。
- **N3.4 prompt**：新建 `solutions/weknora-connector`（或并入 customer-support 的 settings 区块）：只做 WeKnora 对接配置界面——Base URL、API Key、知识库白名单、检索阈值，存 Solution 配置；提供 `health` 探测；**不实现任何知识库前端**（WeKnora 自带 UI，通过 kb.leaif.com 或内网访问）。consoleExtensions 声明一个设置页。
- **N3.5 prompt**：把旧树 `apps/mobile` 迁入 `We/weflow-solutions/solutions/customer-support/apps/mobile`；接入新 Core API（baseUrl 保持 https://api.leaif.com）；新增拍一拍展示、图片/文件/视频/语音上传与播放（参考本仓 media api）；账号体系确认走 Core identity（D7 兼容）；跑 vitest。
- **N3.6 prompt**：按 D1 用 npmjs 账号登录（`npm login`），把 `customer-support-strategy`、`product-troubleshooting`、`support-web` 发布为 public 包（scope 与版本号对齐 manifest ref）；输出发布清单与后续「改代码→发版→Console 一键更新」的流程文档。

### Phase 4：本机全链路联调（验收）
```
N4.1 本机启动编排(一键脚本) → N4.2 微信端到端验收 → N4.3 人工介入验收(console+mobile web)
```
- **N4.1 prompt**：写 `scripts/start-all.ps1`：按序启动 postgres/redis(docker compose)、channel-host(uv)、core api、agent-worker、ingestion-worker、console、support-web dev；每个服务健康检查通过才继续；失败即停并输出日志尾。
- **N4.2 prompt**：用真实微信完成验收清单：好友消息（文字/图片/语音/文件）自动回复、群聊 @机器人回复、引用回复、表情包显示 [表情包]xxx、多账号（若 D5）隔离验证、WeKnora 知识检索命中（问一个知识库问题）。
- **N4.3 prompt**：console 与 mobile（web 预览）登录同一账号；创建 AI 员工并绑定一个客户；让该客户发消息验证 AI 员工回复；人工接管（handoff）→ 回复 → 交回；验证拍一拍、上传媒体、通知。

### Phase 5：远程上线（38.22.235.27）
```
N5.1 frpc 重写+自启 → N5.2 mobile 构建发布(D2) → N5.3 caddy/域名验收 → N5.4 运维脚本
```
- **N5.1 prompt**：重写本机 `frpc.toml`：serverAddr 38.22.235.27:7000，token=`3bd8e3343e75ae5f783a7855843fb0d4`；两个 proxy：`weflow-api`（3100→28660）、`weflow-web`（5173→28661）；frpc 做成 Windows 计划任务/服务自启；验证 `https://api.leaif.com/health` 200。
- **N5.2 prompt**：按 D2 出 APK：本地构建优先（`eas build --local` 或 `npx expo run:android`）；安装到手机验证登录+会话+推送；apk 存 `artifacts/`。
- **N5.3 prompt**：验证 caddy：`web.leaif.com` 打开 console 登录页、`api.leaif.com` 健康检查、证书有效；手机 4G/5G 网络访问全流程；若开放 kb.leaif.com：服务器 frps allowPorts 扩 28662，本机 frpc 加 `weflow-kb`（8080→28662），caddy 反代并对 WeKnora 前端加 basic-auth 或只限内网。
- **N5.4 prompt**：重写 `weflow-ops`：本机侧 watchdog（channel host/微信进程/core/worker/console 心跳+自愈）、备份（Postgres dump + 文件存储 + 微信 .data 增量）；服务器侧 cron 检查 frps/caddy/证书续期；钉钉/邮件告警可选。输出运维手册。

---

## 5. 验收总清单（对应原 11 条需求）

1. Console 通过 ExtensionHost 动态载入客服工作台（真实 dist 模块）✅
2. 微信自动回复/手动回复 ✅
3. 图片/语音/文字/文件对话 ✅
4. 工作台+mobile 人工介入、agent 托管保持、WeKnora 唯一知识库（配置界面）、无建议回复、记忆可用、AI 员工分配客户、远程可用、账号通用、拍一拍与媒体 ✅
5. 表情包 → `[表情包]xxx` ✅
6. npm public 包 + console 易用 ✅
7. 极简插件管理/自动升级/下载 ✅
8. 群聊引用/@、知识查询、AI 员工 prompt 简单配置+绑定客户 ✅
9. 多微信账号隔离 ✅
10. 微信客户端式工作台 + 隐藏页 ✅
11. 影子模式隐藏 ✅

---

## 6. 风险与备注

- 微信 UI 自动化（wechatauto）有封号风险：默认只读 DB 路线，发送用 UIA 少量操作；大促/群发慎用。
- 本机作为「生产」机器：ups、开机自启、远程桌面不可关。
- WeKnora 本机 docker 数据要纳入备份。
- 服务器 1.9GB 内存不足以跑 Core/WeKnora，勿试图上服务器部署。
