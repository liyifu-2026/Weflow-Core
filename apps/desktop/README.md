# Weflow 桌面端（Tauri 壳）

Weflow 的 Windows 桌面端：Tauri 2 + WebView2 壳，只负责把产品网页端（support-web）装进一个原生窗口，**业务零改动**——壳内加载的就是 api 进程托管的同一套前端。

## 架构

- 壳启动后加载目标地址（运行时配置 `weflow.conf`，exe 同目录）：
  ```json
  { "url": "http://127.0.0.1:3100" }
  ```
- 未配置时回落编译期默认 `http://127.0.0.1:3100`（同机部署，api 同时托管前端）。
- 指向远程服务器只需改 `weflow.conf`，无需重新打包。
- 离线/服务不可达时显示内置引导页（`src-tauri/ui/index.html`）。
- **下载即打开**：页面里的「下载」由 WebView2 落盘到系统下载目录，下载完成后壳用系统默认程序打开该文件（`on_download` → `tauri_plugin_opener::open_path`，Rust 侧调用，不给远端页面开任何 IPC 权限）。文档预览因此不必内建查看器——PDF/图片在浏览器内预览，docx/xlsx/pptx/zip 等下载后由本机 Office/解压工具打开。窗口在 `src-tauri/src/main.rs` 里用 Rust 构建（`tauri.conf.json` 的 `app.windows` 为空），只有 builder 能挂 `on_download`。
- 自动更新：Tauri updater 已预留占位（`src-tauri/tauri.conf.json` 的 `plugins.updater`），启用前需：
  1. 生成密钥对：`npx tauri signer generate`；
  2. 把公钥填入 `pubkey`；
  3. 指向自托管更新源（`endpoints`），更新产物随发布流程上传。

## 构建与打包

前置：Rust（MSVC 工具链）+ Node.js。

```powershell
cd weflow\apps\desktop

npm install        # 安装 @tauri-apps/cli
npm run build      # 产出 Release exe + NSIS 安装包
```

产物位置：

| 文件 | 路径 |
|------|------|
| 可执行文件 | `src-tauri/target/release/weflow-desktop.exe` |
| 安装包（Win11 可直接安装） | `src-tauri/target/release/bundle/nsis/Weflow_2.0.0_x64-setup.exe` |

开发调试：

```powershell
npm run dev   # 打开壳窗口；前端仍是远程/同机地址
```

## 改了 support-web 前端后，桌面端看不到新效果？

这是最容易踩的坑：桌面壳加载的是 **api 进程托管的 `support-web/dist` 静态构建产物**，不是 Vite 开发服务器。两套入口的内容来源不同：

| 前端入口 | 加载的内容 | 改前端后 |
|----------|-----------|---------|
| `localhost:5174` / `web.leaif.com`（Vite dev） | 实时源码 | 刷新即见 |
| **桌面端（Tauri 壳）** | `support-web/dist` 产物 | **必须重建 dist** |

正确顺序：

```powershell
# 1. 重建 support-web 产物（core-api 托管的是磁盘目录，无需重启 api）
cd weflow-solutions\solutions\customer-support\apps\support-web
npx vite build

# 2. 桌面壳窗口 Ctrl+R（或关掉重开）
```

验证产物确实更新：`dist/assets/*.js` 的文件名 hash 会变化；或 grep 产物中是否包含新增的特性代码（如新端点路径）。

## 验收（Win11）

1. 服务器按 `docs/deployment-guide.md` 部署并运行；
2. 双击安装 NSIS 安装包，启动 Weflow；
3. 登录 → 收发消息 → Handoff 处置，与浏览器端一致；
4. 修改 `weflow.conf` 指向另一台服务器，重启后加载新地址。
