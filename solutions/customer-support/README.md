# Customer Support Solution

Weflow AI 客服产品的业务 Solution（R3 平台化拆除后，插件由 Core 从 `WEFLOW_PLUGIN_DIR` 直读加载，不再打包安装）。

## 组成

- Execution Strategy：`plugins/customer-support-strategy`（含 AI 员工 Prompt 解析）
- Skill：`plugins/product-troubleshooting`
- App：`apps/support-web`（产品唯一网页端）
- App：`apps/mobile`（产品移动端）
- BFF：`backend/customer-support`（AI 员工管理 + 只读投影端点）

## 加载方式（R3）

- Core API 进程：`WEFLOW_PLUGIN_DIR/backend/customer-support/index.js`，导出 `registerRoutes(server, ctx)`
- Core agent-worker：`WEFLOW_PLUGIN_DIR/plugins/<name>/dist/index.js`，导出 `strategy`/`createStrategy`/`skill`

## 验证

- support-web：`npx vue-tsc --noEmit` + `npx vite build`
- e2e gate：`node scripts/e2e-gate.mjs`（平台运行中）
