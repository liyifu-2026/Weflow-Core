# Source manifest

本仓库是干净快照，不包含旧 Git 历史。以下清单记录来源、落点和有意排除的内容。

| Source | Destination | Rule |
| --- | --- | --- |
| `weflow-server` | `core` | Core TypeScript 代码、数据库迁移、测试和运行时基础设施 |
| `weflow-mobile` | `apps/mobile` | 客服人工接管移动端，保留其移动端工具链（目标目录已随仓库清理移除） |
| `zhinankb-frontend` | `apps/console` | 管理/知识运营工作台，保留其前端工具链 |
| `wxbot/channel_host` | `runtimes/channel-host-wechat` | 独立 Windows/Python Channel Host（目标目录已随仓库清理移除） |
| `wxbot/wechatauto` | `drivers/wechatauto/wechatauto` | 微信桌面自动化 Driver（目标目录已随仓库清理移除） |
| ZhiNanKB/WeKnora | 外部 Provider | 不复制源码，不纳入 Weflow 运行时 |
| `wechatbot-new` | 独立归档仓库 | 不复制源码，保持独立归档 |

> 上表中标注「目标目录已随仓库清理移除」的条目仅作历史迁移记录；`apps/mobile`、`runtimes/channel-host-wechat`、`drivers/wechatauto` 不再随本仓库发布。Channel Host 作为平台级抽象仍由 `contracts/channel/README.md` 描述。

以下内容不进入正式仓库：环境文件、虚拟环境、依赖目录、构建产物、媒体缓存、日志和本地数据库。
