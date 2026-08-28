# ADR-0004：Case-facts 持久化能力整体移除

## Status

Accepted — Phase 7 后清理（2026-08-23）

## Decision

Core 不再提供任何 Case-facts 持久化能力。`case_states` 表（含 intent、stage、knownFields、missingFields、askedFields、actionHistory、riskLevel 等客服业务字段）通过编号迁移 `0056_drop_case_states.sql` 删除，同时移除：

- `conversations/application/case-service.ts` 及其写入边界；
- Handoff 服务中硬编码的 Case 重置写路径（`{ requiresHuman: false, stage: "answering" }`）;
- 会话注意力评分中的 `riskLevel` 因子与客户端知识服务中的 `knownFields` 提示输入；
- Solution 端 Execution Strategy 输出的 intent/stage/facts 死协议片段。

未来任何 Solution 若需要结构化事实存储，必须通过插件 seam 另行设计正式契约（经 Domain Service 写入、带并发控制），不得恢复 `case_states` 或在 Core 中重建等价表。

## Scope

本决定只清除 ADR-0003 宣布迁出但残留在 Core 的 Case-facts 机制，不改变 Conversation、Message、Handoff、Memory 的既有语义，不引入新的事实存储契约。

## Consequences

- 行为变化：会话注意力评分不再参考 case 风险等级；知识检索提示不再使用 knownFields；Handoff 解决时不再写 Case 终态。
- 平台规则回归一致：Core 内零客服业务词汇与业务状态机（见 core/CONTEXT.md Flagged ambiguities）。
- 历史数据随迁移删除；如需保留审计副本，应在执行 0056 前自行导出。
