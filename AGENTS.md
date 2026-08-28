# Weflow repository guidance

## Scope

本目录是 Weflow 的干净收敛仓库。进行修改时，优先保持职责清晰、接口稳定和迁移可回滚；不要把旧仓库的临时编号重新带回正式命名。

## Canonical names

- `core`：Weflow 核心，不叫 Server2
- `apps/console`：管理与运营工作台

`SERVER1_*`、`Server1Client` 等只允许作为短期兼容 alias 或历史数据说明出现。新代码应使用 Channel Host 术语。

## 职责边界：Core / Console / Solutions

- **Core / Console（`weflow`）**：平台层。负责认证、会话/消息/Handoff 等领域事实、系统管理、ExtensionHost、审计、设置等平台级能力。
- **Solutions（`weflow-solutions`）**：业务层。负责具体业务逻辑、业务 UI、业务策略、业务技能、业务 BFF；`weflow-solutions` 是业务 Solution 的唯一来源。
- 业务 UI 通过 `solution.manifest.json` 的 `consoleExtensions` 嵌入 Console；Console 只负责用 `ExtensionHost` 承载，不实现业务页面本身。

## 绝对禁止

- 禁止在 `weflow/apps/console` 中实现业务专属界面，包括但不限于：
  - 客服工作台
  - 会话 / Handoff 业务页面
  - 微信 / 具体通道相关 UI
  - 任何只属于某个 Solution 的页面
- 禁止在 Core 中硬编码业务策略、业务 Prompt、业务状态机。
- 禁止把 `weflow-solutions` 里的业务功能反向搬到 `weflow`（含 `apps/console`、`core` 及其他平台目录）。

## 允许

- Console 可以增加平台级、业务中立的通用能力，例如：
  - ExtensionHost 增强
  - 通用导航 / 设置 / 审计 / 系统状态
  - 平台级 API 接入
- 新增页面必须不依赖任何具体 Solution 才能运行；一旦页面依赖某个业务 Solution，就属于业务 UI，应放入 `weflow-solutions`。

## 正确开发路径

- 业务 UI：放 `weflow-solutions/solutions/<solution>/apps/<app>`，在 `solution.manifest.json` 的 `consoleExtensions` 声明入口和导航，通过 Console 的 `ExtensionHost` 加载。
- 业务 Agent 能力：放 `weflow-solutions/solutions/<solution>/plugins`。
- 业务后端：放 `weflow-solutions/solutions/<solution>/backend`。
- 平台壳需要改动时：才修改 `weflow/apps/console`，且必须是平台级、业务中立的改动。

## 提交前自检清单

- 本次改动是否修改了 `weflow/apps/console`？
  - 如果是，是否包含业务专属页面/路由/文案/组件？
  - 如果是业务专属内容，必须移到 `weflow-solutions`，不能提交到 Core。
- 本次业务改动是否放在了 `weflow-solutions/solutions/<solution>/`？
  - 如果没有，说明放错仓库。
- 业务页面是否通过 `consoleExtensions` 声明？
  - 如果没有，Console 无法正确挂载。

## 示例

- 正确：
  - `weflow-solutions/solutions/customer-support/apps/support-web`
  - `weflow-solutions/solutions/customer-support/solution.manifest.json` 中的 `consoleExtensions`
- 错误：
  - `weflow/apps/console/src/weflow/views/ConversationsView.vue`
  - 在 Console 中直接写“客服工作台 / 会话 / Handoff 业务页面”

## 违规检测方法

- PR / diff 中若出现 `weflow/apps/console` 下新增业务词（客服、工作台、Handoff 业务页、微信、具体通道 UI 等），必须暂停合入并确认归属。
- 搜索 `weflow/apps/console` 中的业务专属标题、路由、组件；若找不到对应的 `weflow-solutions` 业务来源，即为违规。
- 业务 UI 必须能在 `weflow-solutions/solutions/<solution>/solution.manifest.json` 的 `consoleExtensions` 中找到声明；找不到声明却出现在 Console 中，即为违规。

## Console 路由与导航审计

### 新增路由规则

`apps/console/src/router/index.ts` 中的每个路由必须满足以下条件之一：

| 条件 | 允许的路由 |
|------|-----------|
| 平台认证 | `/login`, `/change-password` |
| 平台管理 | `/system/status`, `/system/users`, `/system/audit`, `/settings`, `/platform/solutions` |
| 平台通用 | `/`（总览）, `/help`, `/account/profile` |
| ExtensionHost | `/extensions/:solutionId/:extensionId`, `/:pathMatch(.*)*`（catch-all） |
| 重定向 | `/system/runtime` → `/system/status`, `/system/knowledge-engine` → `/system/status` |

**禁止在 router/index.ts 中注册任何其他路由。** 业务页面必须通过 `consoleExtensions` + ExtensionHost 加载。

### 侧边栏导航规则

`OperationsShell.vue` 的 `groups` 数组只允许以下标签：

- `"工作台"` → 仅含 `"平台总览"`
- `"平台"` → 仅含 `"系统状态"`, `"业务方案"`, `"用户与角色"`, `"审计日志"`

**禁止在 `groups` 中添加任何业务导航项。** 业务导航必须通过 `dynamicGroups`（从 `extensions.navItems` 动态生成）注入。

### API 响应中立性

`core/modules/operations/` 的 API 响应不得新增业务专属字段。已有字段的业务语义由 Solution 层自行解释。

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
