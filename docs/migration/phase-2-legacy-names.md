# Phase 2 legacy names

本文件是归档说明，不是运行时配置或接口合同。

Phase 2 删除 Core 内部旧 Server1 Connector 和旧 Client2 路由。历史
migration journal、历史审计字段和已应用数据保留原值，以便审计；新代码、
新配置和新写入统一使用 Core、Channel Host、Console 术语。

## 收敛结果

- Core 只通过 `channel.events`、`channel.send`、`channel.media`、`channel.contacts`
  与 Channel Host 交互；旧 Server1 配置、Connector、poller 和 shim 已移除。
- 通道私有字段、`local_id`、媒体源文件和联系人分页属于 Channel Host/适配器；Core
  只接收不透明的 `mediaRef`、`contactRef` 与标准化资料。
- Console 正式入口为 `/console/` 与 `/api/v1/console/*`。
- 旧媒体记录不删除；备份确认后可运行 `pnpm converge:legacy-media` 输出匹配/更新数量，
  将无文件的历史 source-local 记录收敛为明确不可用状态。历史语音同样不会保持假 pending。

## 后续清理

本仓库后续清除了客服业务目录（`apps/support-web`、`apps/support-bff`、`apps/mobile`、
`solutions/customer-support`）与微信实现目录（`runtimes/channel-host-wechat`、
`drivers/wechatauto`）。本文档仅保留命名迁移历史，上述目录不再随仓库发布。
