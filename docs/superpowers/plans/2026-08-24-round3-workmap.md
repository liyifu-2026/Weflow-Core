# 客服业务第三轮工作图（Mobile/Console/知识库/npm 修复与增强）

日期：2026-08-24
角色：本图为策划输出——每个节点是一个智能体（含完整 prompt），可独立分派。
依赖：Phase 0 三节点并行 → Phase 1 两节点并行 + 一节点串行 → Phase 2 两节点并行 → Phase 3 总检。

---

## 关键事实（策划核实的根因，写入各节点 prompt）

1. **AI 员工路由 bug 根因**：manifest 声明 path=`/support/ai-employees`，但 bundle 内部路由是 `/support/admin/ai-employees`——不匹配 → catch-all → redirect 客服工作台。
2. **Mobile 时间颠倒根因**：`apps/mobile/src/ui/format.ts` 的 `formatTime` 用 `toLocaleTimeString("zh-CN", {hour:"2-digit",minute:"2-digit"})` 未设 `hour12:false`——12 小时制且无 AM/PM 标记，上午/下午颠倒。
3. **影子验证**：Console 已 0 处；Mobile 有 110 处（review-feedback、coach 相关）。
4. **npm 现状**：`@weflow-leaif/*` 已发布 6 包（solution-sdk/contracts/plugin-sdk/customer-support-strategy/product-troubleshooting/support-web）；**weknora-connector 未发布**。
5. **CLI 启动已实现**：`weflow/scripts/start-dev.ps1`（channel host+core）与 `scripts/ensure-weflow.ps1`（全服务自检+自启）——D1 无需开发。
6. **WeKnora 凭据**（本轮）：已保存于本机配置（不入仓库）；embed token 与测试 API key 同理。
7. **npm 新 token**：已配置于本机 `.npmrc`（不入仓库），scope `@weflow-leaif`。
8. 登录账号：已保存于本机配置（不入仓库）。

---

# 工作图

```text
Phase 0（并行）
  ├─ Node 0A  Mobile 修复包
  ├─ Node 0B  WeKnora 接入 + 知识展示页
  └─ Node 0C  npm 发布 weknora-connector

Phase 1
  ├─ Node 1A  AI 员工两页合一 + 路由修复   （与 0B/1B 并行）
  ├─ Node 1B  工作区/联系人重构 + 白名单页   （与 0B/1A 并行）
  └─ Node 1C  左侧导航 + 影子验证彻底删除    （依赖 1A：同改 router.ts）

Phase 2
  ├─ Node 2A  npm 插件市场页                （依赖 0C；可并行）
  └─ Node 2B  共同问题后端（实时性/结束态/头像） （依赖 0A 的 mobile 部分产出）

Phase 3
  └─ Node 3A  QA 总检查与发布               （依赖全部）
```

**文件冲突规避**（已按文件域切分）：
- 0A 只动 `apps/mobile/**`；1A 动 `router.ts + manifest + AiEmployees*.vue`；1B 动 `ConversationsV2.vue + 新白名单页`；0B 动 `KnowledgeV2.vue + knowledge 目录 + weknora-connector`；1C 动 `App.vue + CoachV2/PoliciesV2 + router.ts`（故依赖 1A）。
- 所有节点：不提交 git（主控统一提交）；改完必须跑各自 typecheck/test。

---

## Node 0A：Mobile 修复包（时间/头像/交接摘要/实时性/影子删除）

**工作目录**：`C:\Users\12991\Desktop\We\weflow-solutions\solutions\customer-support\apps\mobile`（Expo RN，遵守 `apps/mobile/AGENTS.md`）

**任务**：
1. **时间颠倒修复**：`src/ui/format.ts` 的 `formatTime` 加 `hour12: false`（24 小时制），保持 HH:mm。
2. **时间点击才显示**：会话消息时间默认不渲染；点击消息（或长按）展开显示时间戳。参考 `message-presentation.ts`/`timeline.tsx` 的消息行组件。**Console 不在此节点范围**。
3. **头像与 Console 同步**：手机端头像从 Core 拉取——联系人头像用 `avatarUrl`（Core 已有 `/api/v1/auth/avatar` 上传 + 头像代理）；客服本人头像用 auth me 接口的 avatarUrl。修改 `ui/user-avatar.tsx` 与消息头像组件，缺失时回退默认。验证：Console 换头像后 mobile 显示同一头像。
4. **交接摘要修复 + 条件显示**：`handoffs/brief-view.tsx` 的 HandoffBrief 数据加载打通（当前"不可用"——检查 briefing 字段来自 Core 的 handoff briefing 合同）；**无需处理（无 handoff/已 resolve）时不显示交接摘要**。
5. **影子验证/复盘删除（mobile 侧）**：删除所有"标记本条回复需要复盘/影子/coach"相关 UI 与逻辑（约 110 处引用，含 review-feedback 按钮、coach 入口）。
6. **发送实时性**：发送消息后立即在本地会话流中显示（乐观更新 + send outcome 对账），不再需重开会话。

**验收**：`npx tsc --noEmit` 通过；`npx vitest run`（若有测试）通过；时间 24 小时制正确；影子关键词 grep=0；发送即时显示。

---

## Node 0B：WeKnora 接入 + 知识页只读展示

**工作目录**：`C:\Users\12991\Desktop\We\weflow-solutions`（weknora-connector solution + support-web 的 KnowledgeV2）

**背景**：WeKnora 官方文档 https://github.com/Tencent/WeKnora/tree/main/docs。本机 docker 已跑 WeKnora（127.0.0.1:8080）。凭据见顶部事实 6。

**任务**：
1. **kb.leaif.com 进入 WeKnora 画面**：当前返回 401 JSON。方案：WeKnora 前端已在本机 8080；问题在 WeKnora 需要登录。两种路径（优先 A）：
   - A. 用 Core 已有 knora-bridge（weflow 账号 → WeKnora 代管登录）：修桥接链路，让 kb.leaif.com 打开时重定向 WeKnora 登录页或自动登录（WeKnora 账号 admin@weknora.com）。
   - B. 官方 embed iframe：用事实 6 的 embed 代码（token）做一个 kb.leaif.com 落地页，内嵌 WeKnora 的 embed 视图。
   - 完成后 `https://kb.leaif.com` 浏览器可见 WeKnora 界面（不再是 JSON）。
2. **插件知识页只读化**：`support-web/src/views/KnowledgeV2.vue` 只做**展示**——按官方文档设计：知识库列表、文档列表、文档预览/引用、检索测试；**删除所有管理操作**（上传/编辑/删除/数据源配置等按钮全移除）。管理统一在 kb.leaif.com 的 WeKnora 原生界面。
3. **展示内容数据源**：用 Core 的 knowledge 路由（已接 WeKnora client）或直接用测试 API key 调 WeKnora API（`GET /api/v1/knowledge-bases`、文档列表、`knowledge-search`）。阅读 WeKnora 官方文档确定正确端点与字段。

**验收**：kb.leaif.com 浏览器能见 WeKnora 登录/主界面；知识页无任何管理按钮；展示数据真实来自 WeKnora。

---

## Node 0C：npm 发布 weknora-connector

**工作目录**：`C:\Users\12991\Desktop\We\weflow-solutions`

**任务**：
1. `solutions/weknora-connector/` 打包为 npm 包：创建 `apps/settings/package.json`（name `@weflow-leaif/weknora-connector`，version 1.0.1，files 含 settings.js），根目录 package.json 引用。
2. 用新 token 发布：`npm publish --access public --registry=https://registry.npmjs.org/`（token 保存在本机 `.npmrc`，不入仓库）。
3. 验证 `npm view @weflow-leaif/weknora-connector` 返回 1.0.1。

**验收**：npm 上可查到该包。

---

## Node 1A：AI 员工两页合一 + 路由修复

**工作目录**：`C:\Users\12991\Desktop\We\weflow-solutions\solutions\customer-support`（support-web + manifest）

**任务**：
1. **路由修复根因**：manifest path `/support/ai-employees` 与 bundle 路由 `/support/admin/ai-employees` 不一致。修复：bundle 路由改为 `/support/ai-employees`（去掉 admin 前缀），或 manifest path 改 `/support/admin/ai-employees`。推荐前者（manifest 路径是用户可见的短路径）。
2. **两页合一**：AiEmployeesView（员工列表/编辑 prompt）与 AiEmployeeBindingsView（绑定客户）合成**一页**：左侧员工列表 + 右侧"提示词编辑器 + 绑定客户区"（或上下布局）。删除单独 bindings 路由与 manifest 声明。
3. **AI 员工服务拉起**：Core 的 `/api/v1/agent/ai-employees` 与 `/api/v1/agent/contact-bindings` 路由要真实可用（若任务 F 未完成则本节点补：schema 表 + service + routes 注册进 `core/apps/api/main.ts`）。响应形状与 `api/ai-employees.ts` 前端契约一致。
4. 构建 `support-web` 并通过 Playwright 验证：`/extensions/weflow.customer-support/support-ai-employees` 显示 AI 员工页（非客服工作台）。

**验收**：AI 员工页显示正确；两入口合一；创建员工→编辑 prompt→绑定客户闭环可用；typecheck 通过。

---

## Node 1B：工作区/联系人重构 + 白名单配置页

**工作目录**：`C:\Users\12991\Desktop\We\weflow-solutions\solutions\customer-support\apps\support-web`

**任务**：
1. **列表模式重构**（改 ConversationsV2.vue 的 `listMode` 逻辑）：
   - 去掉"三区/AI白名单/全部"三按钮，改为**两页**：
     - **工作区**（默认）：三区布局（等待处理红/我处理的蓝/其他对话灰）。工作区只显示**白名单客户**（`agentEnabled=true`）——"其他对话"即"无需处理的白名单客户"。
     - **联系人**：**所有人**（不论白名单），只读浏览（不支持操作/回复）。
2. **白名单配置页**：新页面（如 `/support/whitelist`）：联系人列表 + 每个联系人"加入/移出白名单"开关（调用 `PATCH /api/v1/contacts/:conversationId` 的 `agentEnabled` 字段——后端已支持）。搜索联系人。
3. 列表接口需过滤：`/api/v1/conversations?scope=...` 目前返回全部；工作区三区需只含白名单。**若 Core 无过滤参数，加 `agentEnabled=true` 查询参数支持**（动 Core 最小改动，与 1A 的 Core 改动协调：不同文件域）。

**验收**：工作区只显示白名单；联系人页显示全部只读；白名单页可切换；typecheck/build 通过。

---

## Node 1C：左侧导航 + 影子验证彻底删除（Console）

**依赖**：Node 1A（同改 router.ts）。

**工作目录**：`C:\Users\12991\Desktop\We\weflow-solutions\solutions\customer-support\apps\support-web`

**任务**：
1. **导航左侧化**：删除顶部"会话 知识 管理"三栏（App.vue 的 `wf-app-nav`），改为**左侧导航栏**（会话/知识/管理 三项，竖向，符合 Console 整体布局）。移动端容器内保持可用。
2. **影子验证与教练彻底删除**：
   - 删除 `CoachV2.vue` 文件与路由；
   - `PoliciesV2.vue` 删除影子验证区块；
   - 删除所有"标记本条回复需要复盘"入口（review-feedback UI）；
   - manifest 删除 `/support/coach` 声明；
   - **Core 侧**（如存在）删除/停用 review-feedback 相关路由引用（注意：Core 的 `recordHandoffQualityFeedback` 路由可保留接口但 UI 全删）。
3. 构建 + 验证 grep "影子|复盘|coach"（前端）= 0。

**验收**：左侧导航正常；影子关键词清零；三区/白名单/知识/AI员工页全部可从左侧导航进入。

---

## Node 2A：npm 插件市场页（业务方案页改造）

**工作目录**：`C:\Users\12991\Desktop\We\weflow`（apps/console 的 SolutionsView.vue + core 的 solution 路由）

**任务**：
1. 把 Console 的"业务方案"（SolutionsView.vue）改为 **npm 风格插件市场**：
   - 卡片式列表：icon（用 manifest icon 名映射）、名称、版本、简介、发布者；
   - "已安装/更新可用"状态徽章；
   - **一键安装**（从 npm registry 拉 `@weflow-leaif/*` 最新版 → install → activate）；
   - **一键更新**（对比本地 active 版本与 npm 最新版）；
   - 自动更新开关（复用已实现的后台 poller `solution-auto-update.ts` + `weflowctl config set update.enabled true`）。
2. 后端：Core 加 `/api/v1/admin/solutions/market`（查询 npm registry 可用包）与 `/api/v1/admin/solutions/install-from-npm`（POST：下载+校验+安装+激活）。复用 `solution-registry-client.ts` 与 `solution-pack.ts` 的 install 逻辑（registry 指向 npmjs）。
3. 测试：安装/更新一条链路真实跑通（可用 @weflow-leaif/weknora-connector 做演示包）。

**验收**：市场页显示 npm 包卡片；一键安装/更新可用；typecheck/test 通过。

---

## Node 2B：共同问题后端（发送实时性 / 结束态取消 / 头像昵称）

**工作目录**：`C:\Users\12991\Desktop\We\weflow\core`（+ 必要的 support-web/mobile 配合）

**任务**：
1. **发送实时性**：手动回复/agent 回复落库后，前端能及时收到。Core 已有 `conversation-events`（SSE/事件发布）。检查 `create-manual-reply` 是否发布事件（有 `human_message` 发布）与 Console/mobile 的订阅路径；补齐增量事件推送（新消息事件到 SSE），前端收到后即时渲染，无需重开会话。
2. **结束态取消**：Handoff resolve 后，前端显示"本次人工处理已结束"且不能再次发起。修改：resolve 后**允许再次 take-over**（创建新的 handoff cycle）。Core 的 handoff 状态机要允许 `resolved → take-over`（新建 cycle）；前端去掉"已结束"死胡同提示，显示"重新发起会话"按钮。
3. **头像/昵称**：确认 contact profile 的 avatarUrl/channelDisplayName 在会话列表与聊天头部展示（Console 已有 AvatarImage；mobile 需 0A 配合）。缺失时用昵称首字 fallback。客服本人头像显示在"我"的气泡侧。

**验收**：发送后消息即时出现；resolve 后可再次发起；头像昵称显示正确；typecheck/test 通过。

---

## Node 3A：QA 总检查与发布

**依赖**：0A/0B/0C/1A/1B/1C/2A/2B 全部完成。

**任务**：
1. 全量 typecheck + 测试：`weflow/core`（pnpm typecheck + pnpm test）、`support-web`（build）、`mobile`（tsc --noEmit + vitest）、`apps/console`（type-check + test）。
2. 回归验证（Playwright）：客服工作台三区、AI 员工页、知识页（只读）、白名单页、左侧导航、kb.leaif.com 界面。
3. 重新打包 solution（版本 1.3.0）→ install → activate；weknora-connector 同升。
4. 端到端：真实微信发一条消息 → 白名单客户 AI 回复；非白名单不回复；人工接管回复确认。
5. 输出验收报告（含截图）与遗留问题清单。

---

## 主控已答（无需智能体执行）

- **D1 CLI 启动**：已实现——`weflow/scripts/start-dev.ps1`（channel host + Core API）+ `scripts/ensure-weflow.ps1`（全服务自检，已注册开机计划任务 WeflowEnsure）。用法：`powershell -File scripts\ensure-weflow.ps1`。
- **F2 单独建库**：不需要。npm 包即"库"——每个业务插件一个 npm 包（@weflow-leaif/*），版本与更新由 npm registry 管理；仓库仍统一在 weflow-solutions（monorepo 打包发布）。插件市场节点（2A）即消费这套机制。
- **擅长领域标签定向推送**：记录 backlog，下一版本做（用户确认）。
