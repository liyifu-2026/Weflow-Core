# Weflow repository guidance

## Scope

本目录是 Weflow 的平台仓库。**Weflow 是一个「单进程部署、配置集中、可高效热更新的 AI 客服产品」**——不是 AI 员工平台，没有方案市场，没有微前端。进行修改时，优先保持职责清晰、接口稳定和迁移可回滚；不要把旧仓库的临时编号重新带回正式命名。

## Canonical names

- `core`：Weflow 核心，不叫 Server2
- `apps/console`：退役中的平台壳（R1 收敛后不再承载业务 UI，不新增功能）

`SERVER1_*`、`Server1Client` 等只允许作为短期兼容 alias 或历史数据说明出现。新代码应使用 Channel Host 术语。

## 产品收敛现状（R1 + R3 平台化拆除）

- 平台化系统已整体拆除（R3）：solution pack / store / signature / registry / runner / npm-market / lock / `packages/solution-sdk` 全部删除；示例 solution（`weflow/solutions/knowledge|memory`）删除。
- 插件加载 = 「插件目录直读」：Core 从 `WEFLOW_PLUGIN_DIR`（core/.env 配置，指向如 `weflow-solutions/solutions/customer-support`）直读 backend 插件（`backend/**/index.js` 的 `registerRoutes(server, ctx)` 契约不变）与 agent 插件（`plugins/*/dist`，`SKILL_PLUGIN_PATH`/`STRATEGY_PLUGIN_PATH` 仍可显式覆盖）。
- `solution.extension_settings` 表保留为设置中心通用 JSON 设置存储（主键 scope/key）；读写端点收编至 operations 模块（`/api/v1/admin/solutions/:solutionId/extensions/:extensionId/settings`）。
- weflowctl 只保留 dev（doctor/up/down）+ config/completion；solution 命令族全部删除。
- 0070 迁移删除 `solution` schema 的 installations/versions/operations/operation_payloads/resource_ownership/events/secret_assignments 表。

## 产品收敛现状（R1）

- 产品唯一网页端是 `weflow-solutions/solutions/customer-support/apps/support-web`（自带登录 + 布局 + browser history 真实路径）。
- 微前端机制已删除：`ExtensionHost`、`consoleExtensions` 消费端、extensions store、mount 契约均不存在于本仓库。禁止重建。
- `apps/console` 仅保留平台级页面：登录 / 改密 / 帮助 / Profile / 审计 / 用户 / 系统状态。总览路由重定向到系统状态。

## 职责边界：Core / Console / Solutions

- **Core（`weflow`）**：平台层。负责认证、会话/消息/Handoff 等领域事实、系统管理、审计、设置等平台级能力。
- **Solutions（`weflow-solutions`）**：业务层 + 产品网页端唯一来源。业务 UI（support-web）、业务策略、业务技能、业务 BFF 都在这里。
- 业务 UI 不再通过 `consoleExtensions` 嵌入 Console（该机制已删除）；support-web 直接访问 Core API。

## 绝对禁止

- 禁止在 `weflow/apps/console` 中实现业务专属界面，包括但不限于：
  - 客服工作台
  - 会话 / Handoff 业务页面
  - 微信 / 具体通道相关 UI
  - 任何只属于某个 Solution 的页面
- 禁止在 Core 中硬编码业务策略、业务 Prompt、业务状态机。
- 禁止把 `weflow-solutions` 里的业务功能反向搬到 `weflow`（含 `apps/console`、`core` 及其他平台目录）。
- 禁止重建 ExtensionHost / solution pack 消费端 / 微前端 mount 契约。
- 禁止恢复 solution store / registry / runner / npm-market / signature / lock 机制或 `@weflow-leaif/solution-sdk`。
- 业务插件的加载只走插件目录直读；不要引入打包安装/激活/回滚流程。

## 正确开发路径

- 产品网页端（业务 UI）：`weflow-solutions/solutions/customer-support/apps/support-web`。
- 业务 Agent 能力：`weflow-solutions/solutions/<solution>/plugins`。
- 业务后端：`weflow-solutions/solutions/<solution>/backend`。
- 平台级页面（登录、审计、用户、系统状态等）：放 support-web（事实来源已迁移）；`apps/console` 仅维护既有页面，不新增功能。

## 提交前自检清单

- 本次改动是否修改了 `weflow/apps/console`？
  - 如果是，是否包含业务专属页面/路由/文案/组件？→ 必须移到 `weflow-solutions`。
  - 是否是新增功能？→ Console 已冻结，新增平台功能应放 support-web 或 Core。
- 本次业务改动是否放在了 `weflow-solutions/solutions/<solution>/`？
  - 如果没有，说明放错仓库。

## 示例

- 正确：
  - `weflow-solutions/solutions/customer-support/apps/support-web/src/views/ConversationsV2.vue`
- 错误：
  - `weflow/apps/console/src/weflow/views/ConversationsView.vue`
  - 在 Console 中直接写“客服工作台 / 会话 / Handoff 业务页面”

## 违规检测方法

- PR / diff 中若出现 `weflow/apps/console` 下新增业务词（客服、工作台、Handoff 业务页、微信、具体通道 UI 等），必须暂停合入并确认归属。
- 搜索 `createMemoryHistory`、`ExtensionHost`、`consoleExtensions`：出现即违规。
- 搜索 `solution-store`、`solution-pack`、`solution-registry`、`solution-runner`、`solution-sdk`、`npm-market`：出现即违规（R3 已全部拆除）。

## Console 路由审计

`apps/console/src/router/index.ts` 中的每个路由必须满足以下条件之一：

| 条件 | 允许的路由 |
|------|-----------|
| 平台认证 | `/login`, `/change-password` |
| 平台管理 | `/system/status`, `/system/users`, `/system/audit` |
| 平台通用 | `/`（重定向）, `/help`, `/account/profile` |
| 重定向 | `/system/runtime` → `/system/status`, `/system/knowledge-engine` → `/system/status` |

**禁止在 router/index.ts 中注册任何其他路由。** 业务页面一律在 support-web 的 `src/router.ts` 中。

## Architectural rules

1. Core 通过 `channel.events`、`channel.send`、`channel.media`、`channel.contacts` 与 Channel Host 通信。
2. Core 不读取通道私有数据库，不依赖通道自动化实现，不理解通道私有 ID（如微信 `local_id`）。
3. 通道协议、自动化、源文件解析和 `local_id` 必须留在 Channel Host/适配器内，不进入 Core。
4. Domain Service 是业务事实的唯一写入口。Agent 不直接写数据库。
5. ZhiNanKB/WeKnora 是外部 Provider，不复制进本仓库。
6. 不修改既有事件 wire shape、游标语义、`operationId` 幂等语义或 `unknown` 出站对账语义，除非另有 ADR。
7. Runtime effect 只负责释放进程内资源；不能把已发出的通道消息当作可撤销 effect。

## Validation

修改后至少运行受影响应用的格式检查、类型检查和测试。涉及 Channel 时，额外检查 Core 与 Channel Host 之间的协议说明和边界测试。

Core 的局部约束、领域词汇和 ADR 继续以 `core/AGENTS.md`、`core/CONTEXT.md` 与 `core/docs/adr/` 为准。
