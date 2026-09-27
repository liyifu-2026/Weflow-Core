# Weflow 仓库执行细则（`weflow/AGENTS.md`）

本目录是 Weflow 唯一仓库（引擎层 + 业务层同仓）。架构边界、绝对禁止、正确开发路径、
提交前自检与机械检测规则见**工作区根 `AGENTS.md`（宪法）**，本文件只写仓库级执行
细则，与宪法冲突时以宪法为准。

## Canonical names

- `core`：Weflow 核心，不叫 Server2。
- `apps/console`：退役中的平台壳（冻结：仅维护既有平台页面，不新增功能）。
- `SERVER1_*`、`Server1Client` 等只允许作为短期兼容 alias 或历史数据说明出现；
  新代码一律用 Channel Host 术语。
- 旧方向词汇（`solution-store` / `solution-pack` / `solution-registry` /
  `solution-runner` / `solution-sdk` / `npm-market` / `ExtensionHost` /
  `consoleExtensions` / `createMemoryHistory`）：grep 命中即违规，不得复活。

## 插件直读机制（现行唯一加载方式）

- Core 从 `WEFLOW_PLUGIN_DIR`（core/.env 配置，默认 `../solutions/customer-support`）直读：
  - 业务 BFF：`backend/**/index.js`，导出 `registerRoutes(server, ctx)`；
  - Agent 插件：`plugins/*/dist`（`SKILL_PLUGIN_PATH` / `STRATEGY_PLUGIN_PATH` 可显式覆盖单个插件）。
- 插件导出契约明细见 `solutions/README.md`「插件开发契约」。
- `solution.extension_settings` 表保留为设置中心通用 JSON 设置存储（主键 scope/key）；
  读写端点在 operations 模块（`/api/v1/admin/solutions/:solutionId/extensions/:extensionId/settings`）。
- weflowctl 只保留 dev（doctor/up/down）+ service + config/completion；solution 命令族已删除。
- 迁移 0070 已删除 `solution` schema 的 installations/versions/operations 等表；
  0048–0053 迁移 journal 中可见旧方案词汇，仅属历史记录。

## Console 路由白名单

`apps/console/src/router/index.ts` 中每个路由必须满足下表之一，**禁止注册任何其他路由**；
业务页面一律在 support-web 的 `src/router.ts`：

| 条件 | 允许的路由 |
|------|-----------|
| 平台认证 | `/login`, `/change-password` |
| 平台管理 | `/system/status`, `/system/users`, `/system/audit` |
| 平台通用 | `/`（重定向）, `/help`, `/account/profile` |
| 重定向 | `/system/runtime` → `/system/status`, `/system/knowledge-engine` → `/system/status` |

## 架构规则

1. Core 通过 `channel.events`、`channel.send`、`channel.media`、`channel.contacts`
   与 Channel Host 通信。
2. Core 不读取通道私有数据库，不依赖通道自动化实现，不理解通道私有 ID（如微信 `local_id`）。
3. 通道协议、自动化、源文件解析和 `local_id` 必须留在 Channel Host/适配器内，不进入 Core。
4. Domain Service 是业务事实的唯一写入口。Agent 不直接写数据库。
5. ZhiNanKB/WeKnora 是外部 Provider，不复制进本仓库。
6. 不修改既有事件 wire shape、游标语义、`operationId` 幂等语义或 `unknown` 出站对账语义，
   除非另有 ADR。
7. Runtime effect 只负责释放进程内资源；不能把已发出的通道消息当作可撤销 effect。

## 验证

修改后至少运行受影响应用的格式检查、类型检查和测试。涉及 Channel 时，额外检查
Core 与 Channel Host 之间的协议说明和边界测试。

Core 的局部约束、领域词汇和 ADR 以 `core/AGENTS.md`、`core/CONTEXT.md` 与
`core/docs/adr/`（0001–0015）为准。
