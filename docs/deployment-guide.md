# Weflow 部署指南（Windows 服务器）

从零在 Windows 服务器上部署 Weflow AI 客服产品：数据库 → 三进程服务 → 前端 → 微信通道，直至登录收发消息。并给出产品的核心运维卖点——**热更新规程**。

> R4 部署形态：进程清单 = **api / agent-worker / ingestion-worker** 三个 Windows 服务 + PostgreSQL + Redis；前端由 api 进程静态托管（无需 Vite / Node 前端服务）；微信通道 Channel Host 与微信桌面版同机、运行在登录用户会话中。

---

## 目录

1. [架构与进程清单](#1-架构与进程清单)
2. [环境要求](#2-环境要求)
3. [安装基础设施（PostgreSQL / Redis）](#3-安装基础设施postgresql--redis)
4. [安装产品代码](#4-安装产品代码)
5. [生产配置 .env](#5-生产配置-env)
6. [数据库迁移与初始账号](#6-数据库迁移与初始账号)
7. [构建产物](#7-构建产物)
8. [Windows 服务化（weflowctl service）](#8-windows-服务化weflowctl-service)
9. [前端托管说明](#9-前端托管说明)
10. [微信通道 Channel Host](#10-微信通道-channel-host)
11. [验证：从零拉起到登录收发](#11-验证从零拉起到登录收发)
12. [热更新规程（核心卖点）](#12-热更新规程核心卖点)
13. [监控与日志](#13-监控与日志)
14. [桌面端（Tauri 壳）](#14-桌面端tauri-壳)
15. [附录：端口一览与排障](#15-附录端口一览与排障)

---

## 1. 架构与进程清单

```
                ┌────────────────────────── Windows 服务器 ──────────────────────────┐
                │                                                                    │
  浏览器/桌面端 ─┼──▶ api 服务 (3100) ────── 静态托管前端 dist（SPA + /api 同源）      │
                │      │  │                                                          │
                │      │  └── Postgres (5432) / Redis (6379)                         │
                │      ▼                                                             │
                │  agent-worker 服务 (3101) ── Agent Turn 执行（热更新单位）          │
                │  ingestion-worker 服务 (3102) ── 媒体/语音处理（热更新单位）        │
                │                                                                    │
                │  Channel Host (43123, 用户会话进程) ◀──▶ 微信桌面版（同机）         │
                └────────────────────────────────────────────────────────────────────┘
```

| 组件 | 形态 | 说明 |
|------|------|------|
| api | Windows 服务 | 全部 HTTP API + 静态托管前端 + 后台调度器（轮询/推送/记忆） |
| agent-worker | Windows 服务 | Agent Turn 执行（模型调用、会话模式引擎） |
| ingestion-worker | Windows 服务 | 媒体转码、视觉描述、语音转写 |
| PostgreSQL 16 | 本机服务 | 主数据库 |
| Redis 7 | 本机服务 | 队列（BullMQ） |
| Channel Host | 登录用户会话进程 | 微信通道适配（UIA 自动化，**不可服务化**） |

---

## 2. 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Windows | Server 2019+ / 10 / 11 | 与微信桌面同系统系 |
| Node.js | >=24 <25 | nvm-windows 或官方安装包 |
| pnpm | >=10 | `npm install -g pnpm` |
| Git | 最新版 | 拉代码与热更新回退 |
| PostgreSQL 16 | 16.x | 本机安装（或 Docker） |
| Redis 7 | 7.x | Windows 可用 Memurai / WSL2 Docker |
| 微信桌面版 | 4.1.12+ | 保持登录状态 |
| Python 3.12 + uv | 最新 | 仅 Channel Host 需要 |

---

## 3. 安装基础设施（PostgreSQL / Redis）

**方式 A：Docker（推荐，与开发环境一致）**

```powershell
docker compose -f deploy\compose.yaml up -d
```

**方式 B：本机安装 PostgreSQL 16 + Memurai（Redis 兼容）**

安装后创建数据库与账号：

```sql
CREATE USER weflow WITH PASSWORD '强密码';
CREATE DATABASE weflow OWNER weflow;
```

---

## 4. 安装产品代码

```powershell
mkdir C:\weflow; cd C:\weflow

git clone https://github.com/liyifu-2026/Weflow.git weflow
git clone https://github.com/liyifu-2026/Weflow-Solutions.git weflow-solutions

# 安装依赖（两个仓库）
cd C:\weflow\weflow
pnpm --dir packages/contracts install
pnpm --dir packages/contracts build     # core 的类型别名指向 contracts 产物，必须先构建
pnpm --dir core install
pnpm --dir tooling/weflowctl install && pnpm --dir tooling/weflowctl build

cd C:\weflow\weflow-solutions
pnpm install:all
```

> 目录约定：以下文档统一假设产品根为 `C:\weflow`，两个仓库并列于其下。

---

## 5. 生产配置 .env

```powershell
copy C:\weflow\weflow\core\.env.production.example C:\weflow\weflow\core\.env
notepad C:\weflow\weflow\core\.env
```

逐项填写 `<...>` 占位值。关键项：

| 键 | 必填 | 说明 |
|----|------|------|
| `DATABASE_URL` / `REDIS_URL` | ✅ | 数据库与缓存连接串 |
| `MODEL_API_KEY` | ✅ | 模型密钥，缺失则 Agent 不工作 |
| `WEB_DIST_DIR` | ✅ | 指向前端构建产物（见第 9 节） |
| `SESSION_COOKIE_SECURE` | ✅ | 局域网 HTTP 必须为 `false`；HTTPS 部署保持 `true` |
| `CHANNEL_HOST_BASE_URL` / `TOKEN` | 微信功能 | 与 Channel Host 配对 |
| `WEFLOW_PLUGIN_DIR` | ✅ | 业务插件目录直读根，指向 `weflow-solutions\solutions\customer-support` |

> `.env` 修改后需重启进程生效：`weflowctl service restart`。

---

## 6. 数据库迁移与初始账号

```powershell
cd C:\weflow\weflow\core

# 迁移（幂等，可重复执行）
pnpm migrate:prod

# 创建管理员（密码至少 12 位，输出只显示一次，务必保存）
node --env-file=.env dist/scripts/create-user.js admin --role=admin
```

忘记密码时重置：

```powershell
node --env-file=.env dist/scripts/reset-password.js admin --password=新密码
```

---

## 7. 构建产物

```powershell
# core 后端产物（dist/，服务进程入口）
cd C:\weflow\weflow\core
pnpm build

# 前端产物（support-web/dist/）
cd C:\weflow\weflow-solutions
pnpm build

# 业务插件产物（plugins/*/dist，Core 直读）
# pnpm build 已包含
```

> 顺序约束：`packages/contracts` 改动后，先 `pnpm --dir packages/contracts build` 再构建 core；`weflow-solutions` 的 `pnpm build` 已按依赖顺序串联。

---

## 8. Windows 服务化（weflowctl service）

R4 起 `weflowctl` 提供 `service` 域，用 [WinSW2](https://github.com/winsw/winsw)（单 exe + XML，MIT 协议）把三进程包装为 Windows 服务：自动启动（延迟）、崩溃自动重启（10s/30s 两次后放弃，1 小时重置计数）、日志按大小滚动。

```powershell
cd C:\weflow\weflow

# 1. 下载 WinSW host（18MB，联网一次；已存在则跳过）
node tooling\weflowctl\dist\cli.js service fetch-host

# 2. 安装（生成 tools\winsw\weflow-<key>.exe/.xml 并注册服务；需管理员终端）
node tooling\weflowctl\dist\cli.js service install

# 3. 启动 / 停止 / 重启 / 状态
node tooling\weflowctl\dist\cli.js service start
node tooling\weflowctl\dist\cli.js service stop
node tooling\weflowctl\dist\cli.js service restart
node tooling\weflowctl\dist\cli.js service status

# 卸载
node tooling\weflowctl\dist\cli.js service uninstall
```

等价的系统服务名：`weflow-core-api`、`weflow-agent-worker`、`weflow-ingestion-worker`（也可用 `services.msc` 或 `Get-Service` 管理）。

**install 的前置检查**（不满足会明确报错）：

- `core/dist/apps/api/main.js` 存在（先 `pnpm build`）
- `core/.env` 含 `DATABASE_URL` / `REDIS_URL`
- `tools/winsw/weflow-service.exe` 存在（先 `service fetch-host`）

> **端口冲突提示**：服务与开发进程（`weflowctl dev up`）使用相同端口，二者互斥。切换形态前先 `weflowctl dev down` 或 `weflowctl service stop`。

**Channel Host 不服务化**：微信通道依赖已登录微信桌面窗口的 UIA 自动化，必须运行在登录用户的桌面会话。用任务计划程序设为「登录时启动」（见第 10 节）。

---

## 9. 前端托管说明

前端由 **api 进程静态托管**（`WEB_DIST_DIR` 指向 `support-web/dist`），不再需要 Vite dev server：

- `/` 与所有非 `/api`、`/health`、`/customer-support` 的 GET 请求回落 `index.html`（SPA browser history）
- `assets/*` 带 hash，长缓存（immutable）；`index.html` 不缓存 → 前端整包替换即生效，无需重启
- 前端与 API 同源，无 CORS 配置负担

开发环境仍用 `weflowctl dev up`（Vite 5174 + 热重载）；`WEB_DIST_DIR` 不配置时 api 不注册静态路由，开发互不影响。

---

## 10. 微信通道 Channel Host

```powershell
cd C:\weflow\weflow\runtimes\channel-host-wechat

# 首次安装
uv venv .venv
.venv\Scripts\activate
uv pip install -e .
uv pip install winsdk pypinyin

# 启动（保持微信桌面版已登录；锁屏时发送不可用）
.venv\Scripts\python -m channel_host.main
```

开机自启（任务计划程序，管理员 PowerShell）：

```powershell
schtasks /create /tn "Weflow-ChannelHost" `
  /tr "C:\weflow\weflow\runtimes\channel-host-wechat\run.ps1" `
  /sc onlogon /rl highest
```

---

## 11. 验证：从零拉起到登录收发

```powershell
# 1. 基础设施
docker compose -f C:\weflow\weflow\deploy\compose.yaml up -d

# 2. 服务
cd C:\weflow\weflow
node tooling\weflowctl\dist\cli.js service status

# 3. 健康
curl http://127.0.0.1:3100/health/ready     # {"process":"core-api","status":"ready"}
curl http://127.0.0.1:3101/health/live      # {"process":"agent-worker","status":"ok"}
curl http://127.0.0.1:3102/health/live      # {"process":"ingestion-worker","status":"ok"}

# 4. 前端（返回 SPA 页面）
curl http://127.0.0.1:3100/conversations

# 5. 登录（200 且 Set-Cookie 无 Secure 即局域网可登录）
curl -i -X POST http://127.0.0.1:3100/api/v1/auth/login `
  -H "Content-Type: application/json" `
  -d '{"username":"admin","password":"你的密码"}'

# 6. 启动 Channel Host，用微信给绑定的联系人发消息，验证收发闭环
```

---

## 12. 热更新规程（核心卖点）

Weflow 的部署形态让「改代码 → 上线」不需要停机窗口：api 持有 HTTP 入口保持不动，只滚动重启两个 worker；前端整包替换即时生效。

### 12.1 前端更新（无重启，秒级）

```powershell
cd C:\weflow\weflow-solutions
git pull
pnpm --dir solutions/customer-support/apps/support-web build

# 原子替换（先换名再删旧，避免文件占用）
Rename-Item C:\weflow\weflow\solutions\customer-support\apps\support-web\dist dist.old
# （新 dist 由 build 生成）
Remove-Item -Recurse -Force C:\weflow\weflow\solutions\customer-support\apps\support-web\dist.old
```

生效机制：`index.html` 不缓存，浏览器下次加载即取新版本；`assets/*` 文件名带 hash，新旧共存互不冲突。**用户无感知，不丢会话。**

### 12.2 后端更新（只重启 worker，api 不动）

```powershell
cd C:\weflow\weflow
git pull

# 0. 回退点：记录当前 commit，迁移前做数据库快照（见 12.5）
git log -1 --format=%H > C:\weflow\.last-good-commit

# 1. 依赖与构建
pnpm --dir packages/contracts build   # contracts 有改动时
pnpm --dir core build
pnpm --dir tooling/weflowctl build

# 2. 迁移（幂等；只在有新 migration 时产生变更）
cd core && pnpm migrate:prod && cd ..

# 3. 重启 worker（api 不动，HTTP 零中断）
node tooling\weflowctl\dist\cli.js service restart

# 4. 体检
node tooling\weflowctl\dist\cli.js dev doctor
```

> agent-worker 与 ingestion-worker 不持有监听端口（健康端口仅探活），重启即断点恢复：进行中的 Agent Turn 由 Redis 队列与数据库状态机接管，重启后继续处理。

**插件目录直读**（R3 后唯一插件加载方式）：`WEFLOW_PLUGIN_DIR` 下的 `plugins/*/dist` 与 `backend/` 由 Core 直接 import——改插件后 `pnpm build` 插件 → `service restart` 即生效，无需任何打包/安装/激活流程。

### 12.3 配置更新（.env）

修改 `core/.env` 后：

```powershell
node tooling\weflowctl\dist\cli.js service restart
```

### 12.4 回退

```powershell
# 1. 代码回退
cd C:\weflow\weflow
git revert <bad-commit>        # 或 git reset --hard (cat C:\weflow\.last-good-commit)
pnpm --dir core build
node tooling\weflowctl\dist\cli.js service restart

# 2. 数据库回退（迁移有破坏性变更时，用 12.5 的快照恢复）
```

### 12.5 迁移前快照

任何含 migration 的更新前：

```powershell
docker exec weflow-postgres pg_dump -U weflow weflow > C:\weflow\backup\weflow-$(Get-Date -Format yyyyMMdd-HHmmss).sql
# 恢复：docker exec -i weflow-postgres psql -U weflow weflow < <快照文件>
```

### 12.6 热更新体检

每次更新后：

```powershell
node tooling\weflowctl\dist\cli.js dev doctor    # 服务/DB/Redis/通道协议全项体检
curl http://127.0.0.1:3100/health/ready
```

---

## 13. 监控与日志

| 组件 | 日志位置 |
|------|---------|
| 三个 Windows 服务 | `weflow\tools\winsw\logs\weflow-<key>.out.log` / `.err.log` / `.wrapper.log`（按 10MB 滚动，保留 8 份） |
| Channel Host | 启动任务的控制台输出 / `core\.data\logs\channel-host.*.log` |
| PostgreSQL / Redis | `docker logs` 或系统事件日志 |

健康端点：`/health/live`（进程存活）、`/health/ready`（依赖就绪，503 = Postgres/Redis 异常）。

---

## 14. 桌面端（Tauri 壳）

R4 提供可选的 Windows 桌面端：Tauri WebView2 壳加载产品网页端，**业务零改动**。

- 位置：`weflow\apps\desktop`
- 目标地址可配置：默认 `http://127.0.0.1:3100`（同机部署），改 `weflow.conf` 指向任意已部署 api 地址
- 自动更新：Tauri updater 预留自托管更新源占位（`apps/desktop/tauri.conf.json` 的 `plugins.updater`）
- 构建与使用见 `weflow\apps\desktop\README.md`

---

## 15. 附录：端口一览与排障

### 端口

| 端口 | 服务 | 说明 |
|------|------|------|
| 3100 | api | HTTP API + 前端托管 |
| 3101 / 3102 | agent-worker / ingestion-worker | 健康探针 |
| 5432 / 6379 | PostgreSQL / Redis | 数据层 |
| 43123 | Channel Host | 微信通道（本机回环） |

### 排障速查

| 现象 | 排查 |
|------|------|
| `service install` 报缺 host | 先 `service fetch-host`（或手动下载 WinSW，见报错信息中的 URL） |
| 服务启动后立即停止 | `tools\winsw\logs\weflow-core-api.err.log` 看崩溃栈；常见：端口被 dev 进程占用（`dev down`）、`.env` 缺键、dist 未构建 |
| 服务 Running 但健康 503 | Postgres/Redis 未启动；`docker ps` 检查 |
| 登录 200 但页面仍要求登录 | `SESSION_COOKIE_SECURE=false` 未配置（HTTPS 部署除外）；浏览器 F12 看 Cookie 是否回传 |
| SPA 路由刷新 404 | `WEB_DIST_DIR` 未配置或目录缺 `index.html` |
| 前端更新后仍是旧页面 | 强刷（Ctrl+F5）；确认 dist 替换成功（`index.html` 内 assets hash 变化） |
| 微信收发不通 | 微信已登录且未锁屏；Channel Host 在运行；`CHANNEL_HOST_TOKEN` 两端一致 |
| `tsc` 产物嵌套 `dist/core/` | 已在 R4 修复（tsconfig paths 指向 contracts dist）；出现说明用了旧 tsconfig，`rm -rf dist && pnpm build` |

### 与开发环境的区别

| | 开发（`weflowctl dev up`） | 生产（`weflowctl service`） |
|---|---|---|
| 进程 | tsx 直跑源码，watch 热重载 | node 跑 `dist/`，WinSW 托管 |
| 前端 | Vite dev server (5174) + 代理 | api 静态托管（3100 同源） |
| .env | `core/.env` | 同一文件；`NODE_ENV=production` 时服务生效 |
| 日志 | `core/.dev-logs/` | `tools/winsw/logs/` |
