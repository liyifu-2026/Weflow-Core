# Weflow 完整部署指南

从零开始部署 Weflow 平台 + 客服业务插件 + FRP 隧道，直至完全可运行。

---

## 目录

1. [环境要求](#1-环境要求)
2. [克隆仓库](#2-克隆仓库)
3. [Docker 基础设施](#3-docker-基础设施)
4. [Core 配置与启动](#4-core-配置与启动)
5. [Console 启动](#5-console-启动)
6. [Channel Host（微信通道）](#6-channel-host微信通道)
7. [Agent Worker 启动](#7-agent-worker-启动)
8. [安装客服业务插件](#8-安装客服业务插件)
9. [FRP 公网隧道](#9-frp-公网隧道)
10. [完整启动流程（一键脚本）](#10-完整启动流程一键脚本)
11. [验证与排障](#11-验证与排障)
12. [附录：端口一览](#12-附录端口一览)

---

## 1. 环境要求

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| **Node.js** | `>=24 <25` | 推荐用 nvm-windows 切换 |
| **pnpm** | `>=10` | `npm install -g pnpm` |
| **Docker Desktop** | 最新版 | 使用 WSL2 后端，自带 PostgreSQL + Redis |
| **Python** | `>=3.9` | Channel Host 用，推荐 3.12 |
| **uv** | 最新版 | Python 包管理器，`pip install uv` |
| **Git** | 最新版 | 克隆仓库 |
| **微信桌面版** | `4.1.12+` | Channel Host 读取本地微信数据库 |
| **Windows** | 10/11 | Channel Host 依赖 Windows UIA |

### 安装 Node.js 24

```bash
# 用 nvm-windows
nvm install 24
nvm use 24
node -v  # 应显示 v24.x.x
```

### 安装 pnpm

```bash
npm install -g pnpm
pnpm -v  # 应显示 10.x.x
```

---

## 2. 克隆仓库

```bash
# 选择一个工作目录
mkdir C:\Users\<你>\Desktop\We && cd C:\Users\<你>\Desktop\We

# 克隆平台核心仓库
git clone https://github.com/liyifu-2026/Weflow.git weflow

# 克隆业务插件仓库
git clone https://github.com/liyifu-2026/Weflow-Solutions.git weflow-solutions
```

最终目录结构：

```
We/
├── weflow/                  # 平台核心（Core + Console + SDK）
│   ├── core/                # 后端 API、Agent Worker、数据库
│   ├── apps/console/        # 前端管理控制台
│   ├── runtimes/channel-host-wechat/  # 微信通道（Python）
│   ├── packages/            # SDK（contracts、plugin-sdk、solution-sdk）
│   ├── deploy/              # Docker Compose（PostgreSQL + Redis）
│   └── scripts/             # 启动脚本
└── weflow-solutions/        # 业务插件（客服方案）
    └── solutions/
        ├── customer-support/    # 客服 Solution Pack
        └── weknora-connector/   # 知识库连接器
```

---

## 3. Docker 基础设施

Weflow 需要以下 Docker 容器：

| 容器 | 端口 | 用途 |
|------|------|------|
| `weflow-postgres` | `5432` | Core 主数据库 |
| `weflow-redis` | `6379` | Core 缓存/队列 |
| `WeKnora-app` | `8080` | 知识检索服务 |
| `WeKnora-frontend` | `80` | 知识库 Web UI |
| `ZhiNanKB-qdrant` | `6333-6334` | 向量数据库 |
| `ZhiNanKB-postgres` | (内部) | 知识库元数据 |
| `ZhiNanKB-redis` | (内部) | 知识库缓存 |
| `ZhiNanKB-docreader` | (内部) | 文档解析 |

### 3.1 启动 Core 基础设施（PostgreSQL + Redis）

```bash
cd weflow

# 使用项目自带的 Compose 文件
docker compose -f deploy/compose.yaml up -d

# 验证
docker ps --filter "name=weflow"
# 应看到 weflow-postgres 和 weflow-redis 状态为 healthy
```

### 3.2 启动 WeKnora / ZhiNanKB（知识服务）

WeKnora 和 ZhiNanKB 的部署由各自的仓库管理。如果你已有这些容器在运行（比如之前部署过），直接确认：

```bash
docker ps --filter "name=WeKnora" --filter "name=ZhiNanKB"
```

如果没有，需要从 WeKnora 仓库部署（参考其文档）。默认配置下 Core 连接 `http://127.0.0.1:8080/api/v1`。

---

## 4. Core 配置与启动

### 4.1 安装依赖

```bash
cd weflow

# 一次性安装所有子项目依赖
pnpm install:all
```

如果 `install:all` 报错，可以逐个安装：

```bash
pnpm --dir core install
pnpm --dir apps/console install
pnpm --dir packages/contracts install
pnpm --dir packages/plugin-sdk install
pnpm --dir packages/solution-sdk install
```

### 4.2 配置环境变量

```bash
cd weflow/core

# 复制示例配置
cp .env.example .env
```

编辑 `core/.env`，确保以下关键配置：

```env
# === 数据库 ===
DATABASE_URL=postgresql://weflow:weflow@127.0.0.1:5432/weflow
REDIS_URL=redis://127.0.0.1:6379

# === AI 模型（必填）===
MODEL_BASE_URL=https://api.deepseek.com
MODEL_API_KEY=sk-你的API密钥
MODEL_NAME=deepseek-v4-flash
MODEL_TIMEOUT_MS=60000

# === 视觉模型（可选）===
VISION_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
VISION_API_KEY=你的视觉API密钥
VISION_MODEL=mimo-v2.5

# === Channel Host ===
CHANNEL_HOST_BASE_URL=http://127.0.0.1:43123
CHANNEL_HOST_TOKEN=dev
CHANNEL_HOST_POLL_INTERVAL_MS=1000

# === WeKnora 知识服务 ===
WEKNORA_BASE_URL=http://127.0.0.1:8080/api/v1
WEKNORA_API_KEY=你的WeKnora密钥
WEKNORA_TIMEOUT_MS=15000
WEKNORA_ORIGIN=https://kb.leaif.com
KNORA_ACCOUNT_ENC_KEY=6f6ee9db2d9eb63ce946878156595bfe55a6bcdb8ad7c87290134cb7d891e547

# === CORS ===
CORS_ORIGINS=https://kb.leaif.com

# === 微信账号（可选）===
WECHAT_ACCOUNT=wxid_你的微信ID
```

> **重要**：`MODEL_API_KEY` 是必填项，没有它 Agent 无法运行。

### 4.3 数据库迁移

```bash
cd weflow/core

# 设置环境变量（tsx 不自动加载 .env）
$env:DATABASE_URL="postgresql://weflow:weflow@127.0.0.1:5432/weflow"
$env:REDIS_URL="redis://127.0.0.1:6379"
$env:SESSION_SECRET="your-session-secret-at-least-32-chars"

# 执行迁移
pnpm migrate
```

成功后会看到 `database migrations completed`。

### 4.4 创建管理员用户

```bash
# 确保环境变量已设置（同上）
$env:DATABASE_URL="postgresql://weflow:weflow@127.0.0.1:5432/weflow"
$env:REDIS_URL="redis://127.0.0.1:6379"
$env:SESSION_SECRET="your-session-secret"

# 创建管理员（密码至少 12 位）
pnpm create-user admin --role=admin
```

脚本会输出类似：

```
created admin admin
initial password (shown once): xK9mB2vP7qR4wN1j!aA1
```

> **务必保存这个密码**，它只显示一次。

如果忘记密码，用 `reset-password` 重置：

```bash
pnpm reset-password admin --password=YourNewPassword123
```

### 4.5 启动 Core API

```bash
cd weflow/core

# 加载 .env 环境变量后启动
$env:DATABASE_URL="postgresql://weflow:weflow@127.0.0.1:5432/weflow"
$env:REDIS_URL="redis://127.0.0.1:6379"
$env:SESSION_SECRET="your-session-secret"
$env:CHANNEL_HOST_TOKEN="dev"
$env:MODEL_API_KEY="你的API密钥"
$env:WEKNORA_API_KEY="你的WeKnora密钥"

pnpm dev:api
```

看到 `Server listening on 0.0.0.0:3100` 表示启动成功。

或者使用一键启动脚本（自动加载 .env）：

```bash
cd weflow
.\scripts\start-dev.ps1
```

这会同时启动 Channel Host 和 Core API。

---

## 5. Console 启动

在另一个终端：

```bash
cd weflow/apps/console

pnpm dev
```

Console 启动在 `http://localhost:5173/console/`，自动代理 `/api` 到 Core API（`localhost:3100`）。

打开浏览器访问 `http://localhost:5173/console/`，用第 4.4 步创建的管理员账号登录。

---

## 6. Channel Host（微信通道）

Channel Host 是 Python 服务，负责连接微信桌面客户端、收发消息。

### 6.1 前置条件

- Windows 10/11
- 微信桌面版 4.1.12+ 已登录
- Python 3.9+（推荐 3.12）

### 6.2 安装依赖

```bash
cd weflow/runtimes/channel-host-wechat

# 用 uv 创建虚拟环境并安装依赖
uv venv .venv
.venv\Scripts\activate
uv pip install -e .
uv pip install winsdk pypinyin  # OCR 发送路径的额外依赖
```

### 6.3 配置

Channel Host 的配置在 `channel_host/` 目录下。确保：

1. 微信桌面版已登录
2. Channel Host 能读取微信数据库（首次运行会自动解密）

### 6.4 启动

```bash
cd weflow/runtimes/channel-host-wechat

# 方式一：直接启动
.venv\Scripts\python -m channel_host.main

# 方式二：用 run.ps1
.\run.ps1
```

Channel Host 监听在 `http://127.0.0.1:43123`。

> **注意**：Channel Host 必须在微信登录状态下运行。桌面锁屏时发送功能不可用。

---

## 7. Agent Worker 启动

Agent Worker 负责执行 AI 对话（Agent Turn）。在另一个终端：

```bash
cd weflow/core

# 设置环境变量（同 Core API）
$env:DATABASE_URL="postgresql://weflow:weflow@127.0.0.1:5432/weflow"
$env:REDIS_URL="redis://127.0.0.1:6379"
$env:MODEL_API_KEY="你的API密钥"

# 启动 Agent Worker
pnpm dev:agent-worker
```

如果有客服插件，启动时注入插件路径（见第 8 步）。

---

## 8. 安装客服业务插件

### 方式一：开发期快捷注入（推荐日常开发）

直接在启动 Agent Worker 时注入插件路径：

```bash
cd weflow/core

$env:DATABASE_URL="postgresql://weflow:weflow@127.0.0.1:5432/weflow"
$env:REDIS_URL="redis://127.0.0.1:6379"
$env:MODEL_API_KEY="你的API密钥"
$env:SKILL_PLUGIN_PATH="C:\Users\<你>\Desktop\We\weflow-solutions\solutions\customer-support\plugins\product-troubleshooting\dist\index.js"
$env:STRATEGY_PLUGIN_PATH="C:\Users\<你>\Desktop\We\weflow-solutions\solutions\customer-support\plugins\customer-support-strategy\dist\index.js"

pnpm dev:agent-worker
```

先构建插件：

```bash
cd weflow-solutions

pnpm install:all
pnpm build
```

### 方式二：Solution Pack 安装（正式部署）

#### 8.1 构建插件

```bash
cd weflow-solutions

# 安装依赖
pnpm install:all

# 构建所有插件和应用
pnpm build
```

#### 8.2 打包 Solution Pack

```bash
# 打包客服方案
pnpm pack:solution
```

这会生成 `solutions/customer-support/artifacts/` 下的 `.tgz` 文件。

#### 8.3 通过 Console 安装

1. 打开 Console（`http://localhost:5173/console/`）
2. 进入「业务方案」页面
3. 点击「导入方案」
4. 选择打包好的 Solution Pack（zip 格式）
5. 等待安装完成

#### 8.4 通过 API 安装

```bash
# 先登录获取 token
TOKEN=$(curl -s -X POST http://127.0.0.1:3100/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"你的密码"}' \
  -c - | grep weflow_session | awk '{print $NF}')

# 打包为 zip
cd weflow-solutions/solutions/customer-support
# 将 manifest + lock + signature + artifacts 打成 zip

# 导入
curl -X POST http://127.0.0.1:3100/api/v1/admin/solutions/import \
  -H "Cookie: weflow_session=$TOKEN" \
  -F "file=@customer-support.zip"
```

### 方式三：weflowctl CLI 安装

```bash
cd weflow

# 构建 weflowctl
pnpm --dir tooling/weflowctl build

# 导入方案
node tooling/weflowctl/dist/cli.js solution import \
  --path solutions/customer-support \
  --core-url http://127.0.0.1:3100 \
  --admin-token <your-token>
```

---

## 9. FRP 公网隧道

FRP 用于将本地服务暴露到公网，供外部访问（如微信回调、知识库 UI）。

### 9.1 架构

```
公网用户
    ↓
frps 服务器 (38.22.235.27:7000)
    ↓
frpc 客户端 (你的电脑)
    ↓
本地服务
```

| 域名 | 映射 | 本地端口 |
|------|------|---------|
| `api.leaif.com` | Core API | `3100` |
| `web.leaif.com` | Console | `5174` |
| `kb.leaif.com` | WeKnora 前端 | `80` |

### 9.2 下载 frpc

```bash
# 下载 frp 客户端（Windows）
# https://github.com/fatedier/frp/releases
# 解压到 weflow/tools/frp/

# 目录结构
weflow/tools/frp/
├── frpc.exe          # 客户端
├── frpc.toml         # 配置文件（见下方）
└── frpc.log          # 运行日志
```

### 9.3 配置 frpc.toml

```bash
# 编辑 scripts/frpc.toml
```

内容：

```toml
# Weflow frpc 隧道配置
serverAddr = "38.22.235.27"
serverPort = 7000
auth.token = "你的frp认证token"

# 登录失败不退出，持续重试
loginFailExit = false

# 本地管理接口
webServer.addr = "127.0.0.1"
webServer.port = 7400

[[proxies]]
name = "weflow-api"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3100
remotePort = 28660

[[proxies]]
name = "weflow-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = 5174
remotePort = 28661

[[proxies]]
name = "weflow-kb"
type = "tcp"
localIP = "127.0.0.1"
localPort = 80
remotePort = 28662
```

### 9.4 启动 frpc

```bash
cd weflow/scripts

# 方式一：直接启动
..\tools\frp\frpc.exe -c frpc.toml

# 方式二：用幂等启动脚本（推荐，防重复）
.\frpc-start.ps1

# 方式三：设置开机自启（任务计划程序）
schtasks /create /tn "Weflow-frpc" /tr "powershell -File C:\Users\<你>\Desktop\We\scripts\frpc-start.ps1" /sc onlogon
```

### 9.5 验证隧道

```bash
# 检查 frpc 状态
Invoke-RestMethod -Uri "http://127.0.0.1:7400/api/status"

# 从公网测试（需要服务器 Caddy/Nginx 反代到 frps 端口）
curl https://api.leaif.com/health/ready
```

---

## 10. 完整启动流程（一键脚本）

### 10.1 手动启动顺序

按以下顺序在不同终端启动：

```bash
# 终端 1：Docker 基础设施
docker compose -f weflow/deploy/compose.yaml up -d

# 终端 2：Core API
cd weflow/core
.\scripts\start-dev.ps1
# 或手动：
$env:DATABASE_URL="postgresql://weflow:weflow@127.0.0.1:5432/weflow"
$env:REDIS_URL="redis://127.0.0.1:6379"
$env:SESSION_SECRET="your-secret"
$env:CHANNEL_HOST_TOKEN="dev"
$env:MODEL_API_KEY="你的密钥"
$env:WEKNORA_API_KEY="你的密钥"
pnpm dev:api

# 终端 3：Agent Worker（带插件）
cd weflow/core
$env:DATABASE_URL="postgresql://weflow:weflow@127.0.0.1:5432/weflow"
$env:REDIS_URL="redis://127.0.0.1:6379"
$env:MODEL_API_KEY="你的密钥"
$env:SKILL_PLUGIN_PATH="C:\Users\<你>\Desktop\We\weflow-solutions\solutions\customer-support\plugins\product-troubleshooting\dist\index.js"
$env:STRATEGY_PLUGIN_PATH="C:\Users\<你>\Desktop\We\weflow-solutions\solutions\customer-support\plugins\customer-support-strategy\dist\index.js"
pnpm dev:agent-worker

# 终端 4：Console
cd weflow/apps/console
pnpm dev

# 终端 5：Channel Host
cd weflow/runtimes/channel-host-wechat
.venv\Scripts\python -m channel_host.main

# 终端 6：frpc
cd weflow/scripts
.\frpc-start.ps1
```

### 10.2 使用 start-dev.ps1（推荐）

`start-dev.ps1` 会自动加载 `.env` 并启动 Channel Host + Core API：

```bash
cd weflow
.\scripts\start-dev.ps1
```

停止：

```bash
.\scripts\start-dev.ps1 -Stop
```

---

## 11. 验证与排障

### 11.1 健康检查

```bash
# Core API
Invoke-RestMethod -Uri "http://127.0.0.1:3100/health/ready"
# 应返回 {"process":"core-api","status":"ready"}

# 登录测试
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/v1/auth/login" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"username":"admin","password":"你的密码"}'

# Agent Worker
Invoke-RestMethod -Uri "http://127.0.0.1:3101/health/ready"

# Console
Invoke-RestMethod -Uri "http://127.0.0.1:5173/console/"
```

### 11.2 常见问题

#### 数据库连接失败

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**解决**：确保 Docker 容器在运行：

```bash
docker ps --filter "name=weflow-postgres"
docker start weflow-postgres
```

#### 登录返回 invalid_credentials

**解决**：密码可能不匹配，重置密码：

```bash
$env:DATABASE_URL="postgresql://weflow:weflow@127.0.0.1:5432/weflow"
$env:REDIS_URL="redis://127.0.0.1:6379"
pnpm reset-password admin --password=NewPassword123
```

#### Console 显示"请求未能完成"

**原因**：API 返回 401 或 404。

**排查**：

1. 检查浏览器登录状态（Cookie 是否有效）
2. 检查 Core API 是否在运行：`Invoke-RestMethod http://127.0.0.1:3100/health/ready`
3. 检查缺失的 API 路由（查看浏览器 Network 面板）

#### tsx watch 不自动重启

**解决**：检查 `.data/logs/core.err.log` 看启动错误，手动重启：

```bash
# 先杀掉旧进程
Get-Process -Name "node" | Where-Object {
  (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match "apps/api/main.ts"
} | Stop-Process -Force

# 重新启动
.\scripts\start-dev.ps1
```

#### Channel Host 无法连接微信

**解决**：

1. 确保微信桌面版已登录
2. 确保微信窗口未最小化到托盘
3. 检查 `CHANNEL_HOST_BASE_URL` 配置

### 11.3 日志位置

| 服务 | 日志路径 |
|------|---------|
| Core API | `weflow/core/.data/logs/core.out.log` / `core.err.log` |
| Channel Host | `weflow/core/.data/logs/channel-host.out.log` / `channel-host.err.log` |
| frpc | `weflow/tools/frp/frpc.log` |
| Docker | `docker logs <容器名>` |

---

## 12. 附录：端口一览

| 端口 | 服务 | 说明 |
|------|------|------|
| `3100` | Core API | 主后端 API |
| `3101` | Agent Worker | AI 对话处理 |
| `3102` | Ingestion Worker | 媒体处理 |
| `5173` | Console (dev) | 前端开发服务器 |
| `5432` | PostgreSQL | Core 主数据库 |
| `6379` | Redis | Core 缓存/队列 |
| `43123` | Channel Host | 微信通道服务 |
| `7400` | frpc admin | FRP 管理接口 |
| `8080` | WeKnora | 知识检索 API |
| `80` | WeKnora UI | 知识库前端 |
| `6333-6334` | Qdrant | 向量数据库 |
| `28660` | frps → API | 公网 API 映射 |
| `28661` | frps → Console | 公网 Console 映射 |
| `28662` | frps → KB | 公网知识库映射 |

---

## 快速参考

```bash
# 首次部署完整流程
git clone ... weflow && git clone ... weflow-solutions
cd weflow && docker compose -f deploy/compose.yaml up -d
pnpm install:all
cd core && cp .env.example .env  # 编辑 .env 填入 API Key
pnpm migrate
pnpm create-user admin --role=admin  # 保存输出的密码
cd ../.. && .\scripts\start-dev.ps1
# 新终端：
cd weflow/apps/console && pnpm dev
# 新终端：
cd weflow-solutions && pnpm install:all && pnpm build
# 用快捷注入方式启动 Agent Worker（见第 8 步）
# 启动 frpc（见第 9 步）
```
