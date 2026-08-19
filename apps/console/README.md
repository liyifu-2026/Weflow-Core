# Weflow Console

Weflow 的平台管理控制台，专注查看已接入业务套装的生命状态与安装情况，
并提供简单的平台管理：业务方案、系统状态、用户与角色、运行、审计日志。

该仓库源自 ZhiNanKB 前端，但已清理上游遗留代码和业务运营界面（客服、知识、
策略、Coach 已剥离到独立应用），Console 只保留平台管理能力。

## 开发

要求 Node.js 20.19 或更新版本（推荐与 Core 一致使用 Node.js 24）：

```bash
corepack pnpm install
corepack pnpm dev
```

Vite 默认把 `/api` 代理到 `http://localhost:3100` 的 Weflow Core，可用
`VITE_DEV_PROXY_TARGET` 覆盖。浏览器只使用 Weflow Secure HttpOnly Cookie，
不会持有 ZhiNanKB API Key。

## 校验

```bash
corepack pnpm check
```

`check` 同时验证 Vue/TypeScript、生产构建，以及 Weflow 原生页面不能引用旧知识
兼容层的导入边界。

## 结构说明

- Console 是平台宿主：平台总览、业务方案、系统状态、用户与角色、运行、审计日志；
- 业务方案可通过 `consoleExtensions` 动态声明侧栏入口，Console 以 iframe 动态嵌入业务前端；
- 旧的 ZhiNanKB 业务代码已清理，`src/weflow/**` 是唯一产品入口；
- Console「技术文档」页直接渲染仓库根 `docs/technical-documentation.md`，不在 Console 内维护重复帮助文案。

## 部署

构建后由 nginx 提供静态资源，并将 `/api` 代理至 Weflow Core：

```bash
docker build -t weflow/console:latest .
docker run -e APP_HOST=weflow-core -e APP_PORT=3100 weflow/console:latest
```

生产默认挂载在 `/console/`；如需显式设置，构建时使用 `VITE_BASE_PATH=/console/`，同时在外层网关
配置对应 SPA fallback。生产环境必须通过 HTTPS 提供，以便会话 Cookie 保持
`Secure`。
