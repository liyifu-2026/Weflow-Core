# 客服业务 Go-Live：并行任务分派包（2026-08-24）

> 用法：把下方每个「任务 X」块整体复制，交给一个智能体执行。执行者须遵守工作区根目录 `AGENTS.md`（weflow=平台层 / weflow-solutions=业务层 的架构边界）。

---

## 任务 A：support-web V2 迁移 + 建议回复 UI 移除 + 微信客户端式工作台（业务层）

**工作目录**：`C:\Users\12991\Desktop\We\weflow-solutions`（业务仓库，唯一业务来源）

**背景**：平台核心（weflow 仓库）不包含业务 UI。客服工作台 UI 在本仓库 `solutions/customer-support/apps/support-web`。旧版只有 ConversationsView + PromptManager；旧树 `C:\Users\12991\Desktop\wxbot\weflow-solution-customer-support\apps\support-web\src` 有完整的 V2 工作台（41 文件：ConversationsV2.vue、KnowledgeV2.vue、PoliciesV2.vue、CoachV2.vue、AiEmployeesView.vue、AiEmployeeBindingsView.vue、OverviewV2.vue 等 + stores/router 等），需要迁移过来并做裁剪。

**任务**：
1. 把旧树 `apps/support-web/src` 的 V2 文件迁入本仓 `solutions/customer-support/apps/support-web/src`（**替换**现有 V1 的 ConversationsView/PromptManager 结构，或按 V2 目录组织）。保留 `entry.ts` 的 `mount(container)` 导出契约（Console ExtensionHost 依赖）。
2. **移除建议回复 UI**：V2 中任何「建议回复/回复起草/智能回复」入口、组件、store 引用删除（平台已决定：Core 接口保留，仅关 UI）。知识检索/知识库入口保留。
3. **微信客户端式简化**：ConversationsV2 收敛为「左侧会话列表（头像+昵称+摘要+未读）+ 右侧聊天气泡 + 底部输入栏（表情/图片/文件/语音按钮）」；「更多/高级」功能（策略、教练/影子验证、AI 员工、知识库管理）收进隐藏页（仅 admin 可见或收进设置抽屉），默认不展示。
4. **隐藏影子验证**：CoachV2（影子验证/教练）与 PoliciesV2 的影子区块从主导航移除，收进隐藏页。
5. 表情包消息渲染为纯文本 `[表情包]<含义>`（不要渲染图片截图；contentType === 'emotion' 的消息直接显示文本字段）。
6. 拍一拍：显示「对方拍了拍你」样式消息。
7. `pnpm build`（支持 web 独立 build）必须通过；产物 `dist/support-console.js` 正常产出。

**约束**：只改 `solutions/customer-support/apps/support-web/` 目录；不要动 `plugins/`、`backend/`、`apps/mobile/`；不要改 `solution.manifest.json`（digest 由主控统一处理）；不提交 git（工作树由主控管理）。

**验收**：build 通过；V2 页面可被 Console 加载（有 mount 导出）；建议回复 UI 无残留引用（grep suggestion/suggested 无 UI 引用）；表情包/拍一拍渲染逻辑就位。

**交付**：改动文件清单 + build 结果 + 自检报告。

---

## 任务 B：mobile 迁移 + 拍一拍/媒体上传（业务层）

**工作目录**：`C:\Users\12991\Desktop\We\weflow-solutions`（业务仓库）

**背景**：移动端（Expo/React Native）源码在旧树 `C:\Users\12991\Desktop\wxbot\weflow-solution-customer-support\apps\mobile`（完整 app：api/auth/conversations/handoffs/knowledge/media/notifications/storage/ui 模块，含 vitest 测试）。本仓 `solutions/customer-support/apps/mobile` 目前**不存在源码**（只有 artifacts 里的空 tgz 占位）。`app.json` 的 `extra.apiBaseUrl` 已指向 `https://api.leaif.com`。

**任务**：
1. 把旧树 `apps/mobile`（含 app/、src/、assets/、app.config.ts、eas.json、package.json 等）**整体迁入**本仓 `solutions/customer-support/apps/mobile`。
2. 检查迁移后依赖安装：`pnpm install`（如旧树 lock 可用则保留），`pnpm vitest` 测试通过。
3. 账号体系确认走 Core identity（登录 API 指向 Core `/api/v1/...`，与 console 同一账号体系——已有 auth/session 模块，确认 baseUrl 配置正确）。
4. 拍一拍展示：会话里渲染「对方拍了拍你」；上传能力：图片/文件/视频/语音 上传与播放（media/api.ts 与 Core `/api/v1/media` 对齐，确认上传/下载路径）。
5. 表情包消息渲染为纯文本 `[表情包]<含义>`。
6. 移除建议回复 UI（mobile 侧若有建议回复/智能回复入口，删除）。
7. `eas.json` 保留本地构建配置（eas build --local 出 APK 用）。

**约束**：只改 `solutions/customer-support/apps/mobile/`；不要动 support-web、plugins、backend；不提交 git。

**验收**：`pnpm vitest` 通过；`npx tsc --noEmit`（如配置）通过；APK 本地构建命令可跑通到打包阶段（如环境允许则完整出包；不要求本任务实际出 APK，出包由主控在部署阶段做）。

**交付**：迁移文件清单 + 测试结果 + 构建自检 + 需要 Core API 配合的点（若有）。

---

## 任务 C：Console ExtensionHost 新架构 + /solution-assets（平台层）

**工作目录**：`C:\Users\12991\Desktop\We\weflow`（平台核心仓库）

**背景**：Console 需要正确动态载入业务 Solution 的 UI。当前 `apps/console/src/weflow/views/ExtensionHost.vue` 是旧实现（同步 mount）。旧树 `C:\Users\12991\Desktop\wxbot\weflow\console\src\weflow\extensions\{ExtensionHostView.vue,extension-store.ts}` 有新架构（异步 `mount` 返回 `{unmount,navigate}`、catch-all extensionHost 路由、`/solution-assets` 代理）。另外 Console 的 `/api/v1/admin/solutions/extensions` 已能从 Core 拉取扩展投影（`stores/extensions.ts` 已就位）。

**任务**：
1. 把旧树 extensions 新架构移植到 `apps/console/src/weflow/`：ExtensionHostView（异步 mount 契约 + unmount/navigate）、extension-store（matchExtension/加载）、catch-all 路由（`/extensions/:solutionId/:extensionId` 之类，按现有路由风格）。
2. `/solution-assets` 代理：Console dev server（vite）增加代理，把 `/plugins/<solution>/...` 或 `/solution-assets/...` 映射到 Solution Pack 解包目录（本地开发映射到 `../weflow-solutions/solutions/customer-support/apps/support-web/dist/`）；生产形态由 web 服务器托管（本任务只写 console 侧代理与文档说明，**Core API 的资源路由由主控另行实现**，不要改 `core/apps/api`）。
3. 兼容现有 `mount(container)` 同步形式（新契约支持两者）。
4. 保持现有页面（Login/Users/Solutions 等）不变；`pnpm typecheck` + `pnpm build` 通过。

**约束**：只动 `weflow/apps/console`（**禁止**改 `weflow/core/**` 任何文件）；业务 UI 内容**禁止**写进 console（只做承载壳）；不提交 git。

**验收**：Console 启动后访问客服工作台路由，能加载 `support-console.js` 并挂载（可先用一个临时 stub 模块验证动态 import）；unmount/navigate 正常；typecheck/build 通过。

**交付**：改动文件清单 + 验证方式 + 结果。

---

## 任务 D：frpc 隧道重写 + 自启（部署）

**工作目录**：`C:\Users\12991\Desktop\We\scripts`（新建文件放这里；frpc 二进制若本机没有，从 https://github.com/fatedier/frp/releases 下载 windows amd64 版放到 `C:\Users\12991\Desktop\We\tools\frp\`）

**背景**：服务器 38.22.235.27 上 frps 已运行（bindPort 7000，`auth.token=3bd8e3343e75ae5f783a7855843fb0d4`，`allowPorts=[28660..28661]`）；caddy 已把 `api.leaif.com→127.0.0.1:28660`、`web.leaif.com→28661`。本机旧 frpc 配置（Desktop/Temp/karry/frpc.toml）token 错误且端口越界，已失效。当前本机服务：Core API=3100、Console(web)=5173、Channel Host=43123（不需外网）。

**任务**：
1. 写 `scripts/frpc.toml`：serverAddr=`38.22.235.27`、serverPort=`7000`、`auth.token=3bd8e3343e75ae5f783a7855843fb0d4`；两个 tcp proxy：
   - `weflow-api`：localIP 127.0.0.1, localPort **3100**（Core API）→ remotePort **28660**
   - `weflow-web`：localIP 127.0.0.1, localPort **5173**（Console）→ remotePort **28661**
2. 下载 frpc 二进制（版本 ≥0.61）。
3. 启动 frpc 并验证：`https://api.leaif.com/api/v1/system/status` 不再 502（返回 401 即可，说明隧道通了）；`https://web.leaif.com` 返回 Console 页面。
4. 自启：创建 Windows 计划任务（System 或当前用户，开机自启，重启失败重试）或注册为服务（如 NSSM 不可用就用计划任务），写 `scripts/frpc-start.ps1`。
5. 若 3100/5173 端口被其他程序占用，先查明（Get-NetTCPConnection），与本机主控确认后再处理。

**约束**：不修改服务器 frps 配置（28660/28661 已允许）；不碰仓库业务代码；凭据文件 `scripts/.server-credentials.txt` 可读但**禁止**提交/打印到日志。

**验收**：两条隧道均通（curl https://api.leaif.com 与 https://web.leaif.com 不再 502）；计划任务已注册；重启 frpc 可自动恢复。

**交付**：frpc.toml + 启动脚本 + 计划任务注册命令 + 验证输出。

---

## 任务 F：AI 员工（定义/版本/发布/绑定客户）移植到 Core（平台层）

**工作目录**：`C:\Users\12991\Desktop\We\weflow`（平台核心仓库，`core/` 子目录）

**背景**：owner 需求「AI 员工功能要可用：写好 AI 员工 prompt 后为其绑定客户」。旧树 `C:\Users\12991\Desktop\wxbot\weflow\weflow-server\` 已有**完整实现**（schema + service + routes + 绑定 + 审计），本仓 `weflow/core` 目前只有 `execution_profiles` 表与 `resolveExecutionProfileForAdmission`（全局取一个 active profile），没有 AI 员工概念。任务：把旧树实现移植进当前 core，并接入准入逻辑（按客户绑定选择员工 → 员工携带自己的 Execution Strategy 参数/提示词）。

**可复用资产（先读再抄，不要重新发明）**：
- 旧 schema：`C:\Users\12991\Desktop\wxbot\weflow\weflow-server\infrastructure\postgres\schema.ts` 第 444-526 行（aiEmployeeDefinitions / aiEmployeeDefinitionVersions / workspaceAgentSettings）
- 旧 service：`C:\Users\12991\Desktop\wxbot\weflow\weflow-server\modules\agent\application\ai-employee-service.ts`（665 行：CRUD/版本/publish/rollback/archive/workspace-default/contact-bindings + audit）
- 旧 routes：`C:\Users\12991\Desktop\wxbot\weflow\weflow-server\modules\agent\interface\http-routes.ts` 第 90-270 行（/api/v1/agent/ai-employees*、/workspace-default、/contact-bindings*）
- 旧绑定表：搜索旧 schema 中 `contact_agent_bindings`（contactId + definitionId + updatedAt）
- 旧前端契约：`C:\Users\12991\Desktop\wxbot\weflow-solution-customer-support\apps\support-web\src\api\ai-employees.ts`（DTO 形状：AiEmployee/versions/ContactAgentBinding/ContactSummary）——**保证 API 响应形状与它一致**，这样任务 A 迁移的 V2 工作台无需改动前端即可工作

**任务**：
1. 在 `weflow/core/infrastructure/postgres/schema.ts` 的 agentSchema 区新增三张表：`ai_employee_definitions`、`ai_employee_definition_versions`（含 executionProfileId/executionProfile jsonb 列）、`workspace_agent_settings`；并新增 `contact_agent_bindings`（contactId 引用 conversation.contact_profiles，definitionId 引用 ai_employee_definitions，唯一约束 contactId）。
2. 新建迁移 `core/migrations/0058_ai_employee.sql` + journal 追加 idx 56。
3. 移植 `ai-employee-service.ts` 到 `core/modules/agent/application/`（适配当前 schema 导入路径与 auditEvents 表结构；若当前 auditEvents 无 metadata jsonb 或 eventType 枚举受限，用当前结构最小适配并记录差异）。
4. 移植 http-routes 到 `core/modules/agent/interface/`（保持上述 URL 与响应形状），在 `core/apps/api/main.ts` 注册。
5. **接入准入**：改 `core/modules/agent/application/execution-profile-service.ts`：`resolveExecutionProfileForAdmission(db, { conversationId })` 先查 `contact_agent_bindings` → 有绑定则取该员工的 published 版本 → 返回其 executionProfileId（或生成 profile 快照）；无绑定回落现有全局 active profile。同步改调用方（ingest-channel-events / media dispatcher 等，把 conversationId 传入）。
6. 补测试：`tests/ai-employee.integration.test.ts`（如测试库可用）或至少 `tests/ai-employee.test.ts`（service 级 mock db）：创建员工→发布→绑定客户→准入解析命中该员工；无绑定回落全局。

**约束**：只改 `weflow/core`（schema/迁移/agent 模块/api main）；不提交 git；**不要**修改 `conversations`/`messages` 现有表结构（P1.1 刚加了 channel_account，避免冲突；如必须动 schema.ts 已有表，先确认与主控同步）；`pnpm typecheck` 必须通过；`pnpm test` 相关测试通过。

**验收**：typecheck 通过；`/api/v1/agent/ai-employees` CRUD 与 `/contact-bindings` 可用；准入按绑定解析（有测试证明）；响应形状与旧前端契约一致。

**交付**：改动清单 + 测试结果 + 与旧树实现的差异说明。

---

## 任务 E：表情包文本化 + 拍一拍捕获 + 多账号 account（Channel Host，Python）

**工作目录**：`C:\Users\12991\Desktop\We\weflow\runtimes\channel-host-wechat`（Python/uv 项目，微信 4.x 自动化通道主机；正在运行中，端口 43123，token 由 `core/.env` 的 CHANNEL_HOST_TOKEN 提供）

**背景**：平台决定表情包**不渲染图片截图**，改为文本 `[表情包]<含义>`。channel host 当前对 emotion 消息输出 `[动画表情]` 占位文本。微信「拍一拍」需要捕获为独立事件 kind（如 `pat`），内容为「对方拍了拍你」样式文本。

**任务**：
1. 读 `channel_host/host.py` 与 `event_store.py`：找到 emotion/表情消息处理分支，把内容升级为 `[表情包]<含义>`：先从微信消息的 XML/名称字段提取表情名（如「开心」「[偷笑]」），做一份常用映射表（旧树 `C:\Users\12991\Desktop\wxbot\wechatbot-new\emojis` 有 happy/sad/angry 等九分类素材可参考）；无法识别时兜底 `[表情包]表情`。
2. 拍一拍：识别微信「拍了拍」系统消息（如「xxx拍了拍yyy」），产出 kind=`pat`、content=`对方拍了拍你`（isSelf 按发送者判定；群聊含 senderRef）。
3. **多账号 account 字段（ADR-0005）**：所有产出的事件与联系人增加 `account` 字段：进程通过 `WECHAT_ACCOUNT` 环境变量（或 main.py 现有 `--account`/`account=` 参数）识别当前实例账号，把该值写入每个事件/联系人的 `account` 字段（`null` 时由 Core 回落 `default`）；`http_host.py` 的 `/api/v1/channel/send` 接收可选 `account` 字段，发送时校验与当前实例账号一致（不一致返回错误 `account_mismatch`），保证多实例各自发自己的号。
4. 保留其他消息 kind（text/image/voice/file）不动；**不引入**新外部依赖（uv.lock 变化需 `uv lock` 且经主控确认）。
5. 自测：`python -m pytest channel_host/tests -q` 通过；新增上述三点的单元测试。
6. 与主控确认后重启 channel host（`run.ps1 -Detached`）。

**约束**：只改 `channel_host/` 下代码与测试；不提交 git；**不要**重启正在运行的 channel host 除非主控确认（先完成代码+测试，重启由主控执行）。

**验收**：测试通过；代码审查确认 emotion→`[表情包]xxx`、pat→拍一拍文本、事件/联系人/发送均带 `account`；无新增依赖（或明确列出）。

**交付**：改动清单 + 测试结果 + 与 Core 事件 schema 的兼容说明。
