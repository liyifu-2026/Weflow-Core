# 11 · 桌面端（Tauri 壳）与 Console（退役平台壳）

> 出处：`apps/desktop/`（README、`src-tauri/tauri.conf.json`、`src-tauri/src/main.rs`、
> `src-tauri/ui/index.html`）、`apps/console/`（README、router、package.json）、`packages/ui/`。

## 1. 桌面端 Tauri 壳

**版本与包名（精确口径）**：npm 包 `@weflow/desktop` **1.0.0**；Rust crate `weflow-desktop`
**2.0.0**；Tauri 产品 `productName: "Weflow"` + `version: "2.0.0"`（决定安装包名
`Weflow_2.0.0_x64-setup.exe`）。对外版本锚点以 **2.0.0** 为准。

定位：**Tauri 2 + WebView2 壳，只负责把产品网页端装进原生窗口，业务零改动**——壳内加载的就是
core-api 托管的同一套 `support-web/dist` 静态产物（不是 Vite dev server）。

### 1.1 打包与窗口

- `tauri.conf.json`：productName `Weflow`、version 2.0.0、identifier `com.weflow.desktop`、
  `frontendDist: "./ui"`（内置连接页）、`app.windows: []`（窗口由 Rust builder 构建——只有
  builder 能挂 `on_download`）、`withGlobalTauri: true`（连接页用 `window.__TAURI__`）。
- bundle：NSIS（`installMode: currentUser`）、全套图标；产物
  `bundle/nsis/Weflow_2.0.0_x64-setup.exe`。
- updater **占位**：endpoints 指向 example.com、pubkey 待填；启用步骤见 README
  （`npx tauri signer generate` → 填公钥 → 自托管更新源）。
- Rust：`tauri 2` + `tauri-plugin-opener`；release `strip+lto`；窗口 1440×900 resizable，
  先加载内置连接页 `index.html`。
- **下载即打开**：`on_download` Finished → `open_path`（Rust 自由函数，不经 IPC）——
  桌面端不内建文档查看器。

### 1.2 服务器地址解析（优先级从高到低）

1. 命令行 `--url <addr>`（排障）；
2. exe 同目录 `weflow.conf`（便携/IT 下发，`{"url": "..."}`）；
3. `%APPDATA%\Weflow\weflow.conf`（应用内连接设置写入处）；
4. 编译期默认候选 **`["http://127.0.0.1:3100", "https://web.leaif.com"]`**——按「本机 → 公网」
   顺序自动探测，第一个可达的直接进入（「装完即用」）。

可达性探测 `probe(url)`：解析 URL（仅 http/https）→ `to_socket_addrs` → 逐地址
`TcpStream::connect_timeout` 3 秒——够区分「服务没起来/地址写错」与「服务在」。

### 1.3 连接页（内置 `ui/index.html`）

- 启动流程：状态点（busy 黄脉冲/ok 绿/bad 红）→ `current_server` 读地址 → 显式配置直接连；
  默认候选逐个探测（「自动探测 i/n」）；失败停页显示表单（地址输入 + 连接 + 重新探测 + 错误行），
  **不出现 WebView2 原生错误页**。
- 三个 Tauri 命令：`current_server` / `probe_server(url)` / `save_server_url(url)`
  （校验 http(s) + probe 可达才写盘；优先 exe 目录、不可写退 %APPDATA%）。
- **IPC 收口**：`current_server`/`save_server_url` 带 `is_builtin_page` 守卫（scheme `tauri` 或
  `http://tauri.localhost`）——**产品前端（远端页面）拿不到任何 IPC 能力**。
- 探测可达 → `location.replace(withShellMarker(url))`：给产品页 URL 追加 **`?shell=desktop`**
  （support-web `shell.ts` 据此把右侧检查器默认收起）。

### 1.4 使用须知（高频坑）

- **改了 support-web 前端**：必须 `npx vite build` 重建 dist（api 托管磁盘目录，无需重启 api），
  再在壳窗口 Ctrl+R；验证 = `dist/assets` hash 变化。
- **远程必须 https**（如 `https://web.leaif.com`）：否则生产环境 Secure 会话 Cookie 存不下，
  登录一直失败。
- Win11 验收清单（README）：部署 → 安装 → 登录/收发/Handoff 与浏览器一致 → 改 `weflow.conf`
  换服务器重启生效。
- 构建：`npm install && npm run build`（Rust 工具链 MSVC）；`npm run dev` 开发。

## 2. Console 平台壳（`@weflow/console` 0.1.0，已退役冻结）

- 状态：**不再构建、不再发布**（platform-verify 不构建它、compose 不含它、`weflowctl dev` 的
  `console` key 实际启动的是 support-web）；仅保留平台级页面供本地参考；CHANGELOG
  「Unreleased（已作废）」。
- **路由白名单**（`apps/console/src/router/index.ts`，业务 UI 已全部收敛到 support-web）：

| 类别 | 路由 |
|------|------|
| 平台认证 | `/login`、`/change-password` |
| 平台通用 | `/`（redirect → `/system/status`）、`/account/profile`（redirect → `/?profile=1`）、`/help` |
| 平台管理 | `/system/users`、`/system/audit`、`/system/status`（`meta.admin`） |
| 重定向 | `/system/runtime` → `/system/status?service=runtime`；`/system/knowledge-engine` → `?service=knowledge` |

- 禁止：新增功能、承载业务 UI、复活 ExtensionHost / `consoleExtensions` / catch-all 业务路由 /
  `createMemoryHistory`（grep 命中即违规，见根 AGENTS §7.1/§7.2 扫描表与路由审计）。
- 技术栈：Vue 3.5 / vue-router 4.5 / pinia 3 + `@weflow/ui`（link packages/ui）；
  自带 `src/weflow/**` 平台组件与同款 Cookie 认证；`check:knowledge-boundary` 边界检查脚本。

## 3. `packages/ui`（随 Console 退役，存量维护）

现仅导出 `statusTone/validationTone` + `labels`；README：后续从 support-web 增量抽取
`wf-page/wf-panel/wf-table/wf-inspector` 等，「一次只抽一个稳定的小单元」。唯一消费方是
apps/console。
