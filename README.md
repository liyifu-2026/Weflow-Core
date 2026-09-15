# Weflow

Weflow 是一个「**单进程部署、配置集中、可高效热更新的 AI 客服产品**」。它把多入口消息、Agent Runtime、业务事实和人工协作组织成一个可审计、可热更新的系统。本仓库是 Weflow 平台核心：Core（api / agent-worker / ingestion-worker）、Contracts、Plugin SDK、weflowctl 与微信通道参考实现。

产品网页端是仓内 `solutions/customer-support/apps/support-web`（自带登录 + 应用布局），部署时由 Core API 静态托管。没有方案市场，没有微前端；Console 平台壳已退役。

技术文档入口：[docs/technical-documentation.md](docs/technical-documentation.md)；部署与热更新规程：[docs/deployment-guide.md](docs/deployment-guide.md)。

## Repository shape

```text
weflow/
├─ core/                         # Weflow Core
│  ├─ apps/
│  │  ├─ api/                   # HTTP API 组合根 + 前端静态托管
│  │  ├─ agent-worker/           # Agent Turn 队列消费者
│  │  └─ ingestion-worker/       # 媒体处理队列消费者
│  ├─ modules/                   # Domain/Application 模块
│  ├─ infrastructure/            # 数据库、队列、Provider Adapter、Runtime Kernel
│  ├─ migrations/
│  └─ tests/
├─ packages/
│  ├─ contracts/                 # 稳定公共契约
│  ├─ plugin-sdk/                # Plugin 注册契约
│  └─ ui/                        # 共享 UI 工具（随 Console 退役，存量维护）
├─ apps/
│  └─ desktop/                   # Tauri 桌面端壳（R4）
├─ runtimes/
│  └─ channel-host-wechat/       # 微信通道参考实现（Python）
├─ solutions/                    # 业务代码（原 Weflow-Solutions 仓，2026-09 并入）
│  ├─ customer-support/          # support-web / mobile / plugins / backend
│  └─ weknora-connector/         # WeKnora 连接器（settings 页）
├─ tooling/
│  └─ weflowctl/                 # CLI：dev（doctor/up/down）、service（Windows 服务）、config、completion
├─ tools/
│  └─ winsw/                     # Windows 服务包装（weflowctl service 生成）
├─ scripts/                      # 验证脚本
├─ contracts/
│  └─ channel/                   # 跨进程 Channel 协议说明
├─ deploy/
│  └─ compose.yaml               # 本地开发依赖（PostgreSQL + Redis）
└─ docs/
```

## Runtime vocabulary

- **Core** 持有 Conversation、Message、Case、Handoff、Memory、Audit 等业务事实，并编排 Agent Runtime（Skill / Execution Strategy 由业务插件提供，目录直读加载）。
- **Channel Host** 是平台级通道入口适配层：负责连接外部入口、可靠事件存储、发送操作与媒体引用解析。Core 通过 `channel.events`、`channel.send`、`channel.media`、`channel.contacts` 四个正式能力契约与 Channel Host 通信，不感知具体通道实现。协议说明见 [contracts/channel/README.md](contracts/channel/README.md)。
- **Provider** 是可替换的外部能力实现。ZhiNanKB/WeKnora 保持在系统外部；TextModel、Vision 等同理。

业务代码在仓内 **`solutions/`** 子目录（2026-09 由原 Weflow-Solutions 仓库整仓并入，历史保留）：support-web（产品唯一网页端）、mobile、客服业务插件与业务 BFF，经 `WEFLOW_PLUGIN_DIR` 目录直读加载。

## Development

每个应用保留自己的包管理器。根目录只负责说明拓扑，不强行把 Python、pnpm、npm 等工具链揉成一个包。

- Core：进入 `core/`，使用 `pnpm check`
- weflowctl：进入 `tooling/weflowctl/`，使用 `pnpm build && pnpm test`
- 前端与业务：`solutions/`（`pnpm install:all` / `pnpm build`），support-web 在 `solutions/customer-support/apps/support-web/`

### weflowctl

```bash
# 开发环境（tsx 直跑源码 + Vite dev server + channel-host 托管）
node tooling/weflowctl/dist/cli.js dev doctor   # 体检
node tooling/weflowctl/dist/cli.js dev up       # 体检 + 自动修复（迁移、拉起服务）
node tooling/weflowctl/dist/cli.js dev down     # 停止托管进程

# 生产 / Windows 服务（api / agent-worker / ingestion-worker）
node tooling/weflowctl/dist/cli.js service fetch-host   # 下载 WinSW host（联网一次）
node tooling/weflowctl/dist/cli.js service install      # 安装三个服务（管理员终端）
node tooling/weflowctl/dist/cli.js service start|stop|restart|status
```

完整部署、热更新规程与排障见 [docs/deployment-guide.md](docs/deployment-guide.md)。
