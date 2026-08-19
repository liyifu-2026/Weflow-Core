# Weflow Core

Core 是 Weflow 的平台业务核心。它通过 Channel Host 通用协议接入任意消息通道，为 Console 和其他受保护客户端提供共享的会话、知识、记忆、媒体和 Agent 能力。

本目录是 Weflow 的 Core 项目。旧项目仅作为行为和数据迁移参考；拆分完成后旧项目退役，不再与 Core 双向同步。

## 当前状态

- Channel Host 通过通用 HTTP 协议（HttpChannelProvider/httpChannelPlugin）与 Core 对接；Core 只依赖通道中立的事实（登录态、入站事件、发送操作、媒体、游标），不绑定任何具体通道实现
- Agent 流程由 Execution Strategy 与 Skill 插件驱动：策略与技能由 Solution 插件注册于 ExecutionStrategyRegistry / SkillRegistry，按 execution profile 选择；Core 不内置任何业务策略
- 无活动且兼容的 Execution Profile 时不创建新 Agent Turn；System Prompt 由 Execution Strategy 提供，无策略时使用内置通用平台 Prompt
- Console 是管理端，承载账号、知识、记忆、会话、Handoff、运行状态与审计等管理能力
- solutions/knowledge 与 solutions/memory 是随附解决方案，分别负责知识摄入检索与长期记忆闭环
- handoff（转人工）是平台级概念；memory、knowledge、media、conversations、contacts、identity、operations、solution 等模块一并保留
- 知识检索由外部 Provider 承担；Core 只执行受控检索，并将来源证据纳入 Agent 上下文
- 用户分为 `operator` 与 `admin`；知识与策略变更由 Core Gateway 强制鉴权，浏览器不持有外部知识 Provider 的 API Key

## 本地开发

要求 Node.js 24 LTS、pnpm 10 和 Docker Compose v2。

```bash
cp .env.example .env
mkdir -p deploy/secrets
printf 'weflow\n' > deploy/secrets/postgres_password
docker compose -f deploy/compose.yaml up -d
pnpm install
pnpm migrate
pnpm create-user <username> --role=admin
pnpm build
pnpm check
```

升级既有数据库时，迁移会把现有账号设为 `operator`。迁移完成后需至少执行一次
`pnpm promote-admin <username>`，再使用该管理员账号进入 Console。

三个进程分别启动：

```bash
pnpm start:api
pnpm start:agent-worker
pnpm start:ingestion-worker
```

健康接口默认只监听本机：

- `core-api`: `http://127.0.0.1:3100/health/live` 和 `/health/ready`
- `agent-worker`: `http://127.0.0.1:3101/health/live` 和 `/health/ready`
- `ingestion-worker`: `http://127.0.0.1:3102/health/live` 和 `/health/ready`

本地 `.env` 和 `deploy/secrets/` 不进入 Git。Linux 部署可通过 `DATABASE_URL_FILE`、`REDIS_URL_FILE` 读取只读 secret 文件。

## 文档导航

1. [领域术语](./CONTEXT.md)
2. [确认决策总表](./docs/00-decisions.md)
3. [目标、范围与约束](./docs/01-scope-and-constraints.md)
4. [功能边界](./docs/02-functional-boundaries.md)
5. [运行进程与部署形态](./docs/03-runtime-topology.md)
6. [数据、文件与任务队列](./docs/04-data-and-storage.md)
7. [身份、安全与审计](./docs/05-identity-security-audit.md)
8. [关键业务流程](./docs/06-key-flows.md)
9. [项目目录与依赖规则](./docs/07-project-structure.md)
10. [开发阶段与后续升级](./docs/08-roadmap.md)

## 阅读原则

- 文档中的“模块”表示代码职责分区，不代表独立部署。
- 第一版只有三个 Weflow 应用进程，不做微服务化。
- 标注为“后续升级”的内容不进入第一版开发。
- 尚未确认的技术细节不能被当作既定决策。
