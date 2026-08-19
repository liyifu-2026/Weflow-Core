# Weflow repository guidance

## Scope

本目录是 Weflow 的干净收敛仓库。进行修改时，优先保持职责清晰、接口稳定和迁移可回滚；不要把旧仓库的临时编号重新带回正式命名。

## Canonical names

- `core`：Weflow 核心，不叫 Server2
- `apps/console`：管理与运营工作台

`SERVER1_*`、`Server1Client` 等只允许作为短期兼容 alias 或历史数据说明出现。新代码应使用 Channel Host 术语。

## Architectural rules

1. Core 通过 `channel.events`、`channel.send`、`channel.media`、`channel.contacts` 与 Channel Host 通信。
2. Core 不读取通道私有数据库，不依赖通道自动化实现，不理解通道私有 ID（如微信 `local_id`）。
3. 通道协议、自动化、源文件解析和 `local_id` 必须留在 Channel Host/适配器内，不进入 Core。
4. Domain Service 是业务事实的唯一写入口。Agent 不直接写数据库。
5. ZhiNanKB/WeKnora 是外部 Provider，不复制进本仓库。
6. 不修改既有事件 wire shape、游标语义、`operationId` 幂等语义或 `unknown` 出站对账语义，除非另有 ADR。
7. Runtime effect 只负责释放进程内资源；不能把已发出的通道消息当作可撤销 effect。

## Validation

修改后至少运行受影响应用的格式检查、类型检查和测试。涉及 Channel 时，额外检查 Core 与 Channel Host 之间的协议说明和边界测试。

Core 的局部约束、领域词汇和 ADR 继续以 `core/AGENTS.md`、`core/CONTEXT.md` 与 `core/docs/adr/` 为准。
