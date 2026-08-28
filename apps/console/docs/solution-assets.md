# Solution 静态资源托管（/plugins 与 /solution-assets）

Console 的 ExtensionHost 以同源静态资源方式加载 Solution 声明的
`consoleExtensions[].entry`（如 `/plugins/customer-support/apps/support-web/dist/support-console.js`）。
本文件说明 Console 侧的开发代理行为与生产托管要求。

> 资源路由的权威实现归平台/web 服务器所有；Core API 不负责静态资源。
> 本目录（`apps/console`）只承载壳，不包含任何业务资源。

## URL 形态

两个前缀等价，均映射到 **Solution Pack 解包目录**：

```text
/plugins/<solutionId>/<...path>
/solution-assets/<solutionId>/<...path>
    → <解包根>/<solutionId>/<...path>
```

示例（本地开发，默认解包根为仓库旁的 `weflow-solutions/solutions/`）：

```text
/plugins/customer-support/apps/support-web/dist/support-console.js
  → weflow-solutions/solutions/customer-support/apps/support-web/dist/support-console.js
```

## 本地开发（vite dev / vite preview）

`vite.config.ts` 内置中间件 `weflow-solution-assets-serve`：

- 同时挂载在 `/plugins/` 与 `/solution-assets/` 前缀上；
- 文件名段做白名单清洗（`[^a-zA-Z0-9._-]` 移除），并做路径穿越保护；
- 按扩展名返回 MIME（`.js/.mjs → text/javascript` 等），未识别为
  `application/octet-stream`；
- 未命中的请求交回 Vite 后续管线。

覆盖解包根：

```powershell
# 绝对路径或相对 apps/console 的路径
$env:SOLUTION_ASSETS_ROOT = "D:/packs/unpacked"
pnpm dev
```

默认值为 `<仓库>/../../weflow-solutions/solutions`（即与 `weflow`
并列的 solutions 工作区）。

## 生产形态

生产环境由 web 服务器把两个前缀直接托管到部署机上的解包目录，
不经过 Console 容器与 Core API。以 nginx 为例：

```nginx
# Solution Pack 解包根（部署时挂载/同步）
location ^~ /plugins/ {
    alias /srv/weflow/solution-store/;
    try_files $uri =404;
}
location ^~ /solution-assets/ {
    alias /srv/weflow/solution-store/;
    try_files $uri =404;
}
```

要点：

1. 与 Console 同源（同一域名），扩展 bundle 才能以同源凭据加载；
2. JS 资源必须带 `Content-Type: text/javascript`；
3. 解包目录随 Solution 安装/激活/回滚原子更新；版本切换后建议对
   目录加短缓存或按内容 hash 命名，避免旧 bundle 缓存。

## ExtensionHost 挂载契约

Console 只依赖以下业务中立契约（见 `src/weflow/extensions/runtime.ts`）：

- **新契约**：`mount(el, ctx) => Promise<{ unmount, navigate }>`（也可同步
  返回句柄）。`ctx = { path, user, bridge: { fetch, navigate } }`；
- **旧契约**：`mount(container)` 同步挂载、无返回值——卸载时宿主清空容器，
  如模块导出 `unmount()` 则优先调用。

扩展拿到的只有受限 bridge（带凭据的 `fetch`、平台路由 `navigate`），
永远不会拿到 Console 的 store 或 router 实例。
