# Weflow 业务子树守则（`weflow/solutions/`）

本子树是业务层，也是 **Weflow 产品网页端与移动端的唯一来源**。架构边界、绝对禁止、
正确开发路径见工作区根 `AGENTS.md`（宪法），本文件只写业务子树执行细则。

2026-09 起本子树即原独立仓库 Weflow-Solutions（已归档），整仓并入 `weflow` 仓，历史保留。

## 产品网页端（support-web）规则

- 产品本体 SPA：`customer-support/apps/support-web`，直接访问 Core API
  （Cookie 会话调 `/api/v1/*`），不经任何壳或嵌入机制。
- 入口 `src/main.ts`（标准 SPA 挂载）+ `src/layout/AppShell.vue`（单一侧栏 + 顶栏）；
  路由 `src/router.ts`（browser history 真实路径 + 登录/改密/admin 守卫）。
- 路由一律真实路径：`/conversations`、`/knowledge`、`/admin`、`/settings` 等；
  禁止 `/support` 前缀、hash 路由。
- 平台级管理页（登录/改密/审计/用户/系统状态/设置）也在 support-web 的 `src/views/`。
- 子树内不得存在微前端残留：`src/entry.ts`、`createMemoryHistory`、
  `consoleExtensions` 消费端——出现即违规。
- `operations-web` 已删除；其 Kill Switch / 回滚能力并入 support-web 设置中心。

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

- 插件不打包安装（`solution.manifest.json` / `solution.lock.json` / `signature.json` /
  `artifacts/` 已删除）；导出契约明细见 `solutions/README.md`「插件开发契约」。
- 业务 BFF 只保留鉴权面；AI 员工管理与会话只读投影端点清单见
  `solutions/CONTEXT.md`「已固化的决定」。

## 提交前自检（子树增量）

- 产品 UI 是否放在 `solutions/<solution>/apps/<app>`？没有 → 放错位置。
- 是否误改了 `weflow/apps/console`？是 → 撤回（Console 已冻结，见宪法）。
- 改提示词/决策协议：提示词权威顺序 = AI 员工已发布版本（DB）> 内置客服提示词；
  改提示词走 AI 员工版本管理（support-web 设置中心），不存在 prompts.json 机制。

## 验证

- support-web：`npx vue-tsc --noEmit` + `npx vite build` 必须绿（`pnpm build`）。
- 插件与 support-web 测试入口见 `solutions/CONTEXT.md`「测试入口」。
- e2e gate：`node scripts/e2e-gate.mjs`（平台运行中直接种子会话 + Turn 验证 Agent 链路）。
