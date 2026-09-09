# Weflow Solutions 子树守则（`weflow/solutions/`）

本目录是**业务 Solution 的唯一来源**，同时也是 **Weflow 产品网页端的唯一来源**：`customer-support/apps/support-web` 是产品本体 SPA（自带登录 + 应用布局 + browser history），直接访问 Core API。

2026-09 起本子树即原独立仓库 **Weflow-Solutions**（已归档），整仓并入 `weflow` 仓，历史保留。上一条边界条款「业务在 `weflow-solutions` 仓」一律按本目录理解。

## 产品收敛现状（R1）

- 产品唯一网页端是 `solutions/customer-support/apps/support-web`。
- 微前端机制已删除：不再有 Console ExtensionHost、`consoleExtensions`、mount 契约、memory history、`/support` 路由前缀。禁止重建。
- `operations-web` 已删除；其 Kill Switch / 回滚能力将在 R2 并入 support-web 设置中心。
- 路由一律真实路径：`/conversations`、`/knowledge`、`/admin`、`/settings` 等（见 `apps/support-web/src/router.ts`）。

## 职责边界

- **本子树 `solutions/`（业务层 + 产品网页端）**：业务逻辑、业务 UI（support-web）、业务策略、业务技能、业务 BFF。
- **引擎层 `core/`、`apps/`（平台层）**：认证、会话/消息/Handoff 等领域事实、系统管理、审计、设置等平台级能力。
- support-web 通过 Cookie 会话直接调用 Core API（`/api/v1/*`）；业务 BFF（`backend/`）提供 `ai-employees` 等业务端点。

## 仓库布局约定

```text
solutions/
└─ <solution>/
   ├─ apps/<app>               # 产品/业务 UI（support-web、mobile）
   ├─ plugins/<name>/          # 业务 Agent 插件（Skill / Execution Strategy），
   │                           #   由 Core 从 WEFLOW_PLUGIN_DIR/plugins/<name>/dist 直读
   └─ backend/<key>/index.js   # 业务 BFF（registerRoutes(server, ctx) 契约），
                               #   由 Core 从 WEFLOW_PLUGIN_DIR/backend 直读
```

R3 平台化拆除：`solution.manifest.json` / `solution.lock.json` / `signature.json` / `artifacts/` 已删除；插件不再打包安装，Core 通过 `WEFLOW_PLUGIN_DIR` 环境变量直读本目录的插件目录。

## 绝对禁止

- 禁止把业务 UI、业务页面、业务路由、业务文案、业务组件实现到 `weflow/apps/console`。
- 禁止在 Core 中硬编码业务策略、业务 Prompt、业务状态机。
- 禁止把本子树已下沉的业务功能反向搬回引擎层（`core/`、`apps/`）。
- 禁止在本子树放置平台壳代码（如 Console 本体、Core 内部模块）。
- 禁止恢复微前端机制（entry.ts mount 契约 / memory history / `vite-plugin-css-injected-by-js` lib 构建模式）。

## 正确开发路径

- 产品网页端：`solutions/customer-support/apps/support-web`
  - 入口 `src/main.ts`（标准 SPA 挂载）+ `src/layout/AppShell.vue`（单一侧栏 + 顶栏）
  - 路由 `src/router.ts`（browser history 真实路径 + 登录/改密/admin 守卫）
  - 登录/改密/审计/用户/系统状态/设置页面在 `src/views/`
- 业务 Agent 能力：`solutions/<solution>/plugins`（Skill、Execution Strategy 等）。
- 业务后端：`solutions/<solution>/backend`。
- 平台壳问题去引擎层目录处理，且必须是平台级、业务中立的维护性改动。

## 提交前自检清单

- 本次产品 UI 是否放在 `solutions/<solution>/apps/<app>`？
  - 如果没有，说明放错位置。
- 本次改动是否误改了 `weflow/apps/console`？
  - 如果是，撤回；Console 已冻结。
- 新路由是否是真实路径（无 `/support` 前缀、无 hash）？

## 示例

- 正确：
  - `solutions/customer-support/apps/support-web/src/views/ConversationsV2.vue`
  - `solutions/customer-support/apps/support-web/src/views/AuditView.vue`（平台级管理页放这里）
- 错误：
  - `weflow/apps/console/src/weflow/views/ConversationsView.vue`
  - 任何 `mount(el, ctx)` 微前端契约

## 违规检测方法

- 检查 PR / diff：如果 `weflow/apps/console` 下新增了业务专属标题、路由、组件或文案，立即拦截。
- 检查本子树：`src/entry.ts`、`createMemoryHistory`、`consoleExtensions` 消费端代码不得存在。

## 验证

- support-web：`npx vue-tsc --noEmit` + `npx vite build` 必须绿（`pnpm build`）。
- e2e gate：`node scripts/e2e-gate.mjs`（平台运行中直接种子会话 + Turn 验证 Agent 链路）。
