# Deployment

部署编排属于仓库级关注点，具体应用仍由各自工具链构建。

- `compose.yaml`：本地开发依赖（PostgreSQL 16 + Redis 7），与 `core/.env.example` 默认值匹配：
  ```bash
  docker compose -f deploy/compose.yaml up -d
  cp core/.env.example core/.env   # 并配置 MODEL_API_KEY 等可选项
  pnpm --dir core migrate
  ```
- `core` 提供 `core-api`、`agent-worker`、`ingestion-worker` 三个进程。
- Channel Host 是平台级通道入口适配层，不由 Core 隐式启动；本仓库的参考实现位于 `runtimes/channel-host-wechat`（Python/微信本地自动化），生产环境可按同一契约部署外部适配器。
- `apps/console` 按前端工作台工具链发布；业务 Solution App 由各自 Solution Pack 发布。
- ZhiNanKB/WeKnora 作为外部 Provider 部署，不被复制到本仓库。
- 部署监控脚本（watchdog/backup）属私有运维资产，不随仓库发布。

任何部署模板都必须保持 Core 与 Channel Host 之间的 token、游标、`operationId` 和 `unknown` 对账语义不变。
