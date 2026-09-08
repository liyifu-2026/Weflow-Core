# ADR 0009：会话事件跨进程扇出（Redis pub/sub + 失效信号语义）

- 状态：已接受（2026-09-08）
- 关联：ADR-0001（Agent Turn 执行接缝）、`core/modules/console-events`（SSE 端点）

## 背景

部署形态是 api / agent-worker / ingestion-worker 三进程，但会话事件总线
（`infrastructure/events/conversation-events.ts`）一直是**进程内** `EventEmitter`，
文件注释还写着「core 单进程部署」。由此产生两个实际缺陷：

1. **worker 侧事件到不了前端**：Agent 回复的 `agent_message` 在 agent-worker
   进程发布（`agent-turn-outcome-command.ts`），而 SSE 端点只在 api 进程注册，
   订阅端永远收不到。工作台只能等 Channel Host 回采到自消息（api 进程发布）
   才看到 AI 回复，或者等对账轮询——「AI 回完要等几秒才出现」的根因。
2. **媒体完成没有事件**：图片描述 / 语音转写由 ingestion-worker 落库，此前不发布
   任何事件，前端只能等下一次对账。

## 决策

1. **publish = 本地即时投递 + Redis 广播**（频道 `weflow:conversation-events`）。
   信封带 `origin`（每进程一个随机 UUID）：订阅端收到广播时按 `origin` 跳过自己
   的回环副本，保证每个进程恰好投递一次；投递给订阅者前剥离 `origin`，进程内部
   标识不外泄到 SSE 帧。
2. **角色划分**：api 进程 `subscribe: true`（它是 SSE 消费端），
   agent-worker / ingestion-worker 只发布。三进程都在关闭时释放连接。
3. **事件只是失效信号，不是事实来源**：客户端收到事件后回拉 Core 权威状态。
   因此 Redis 不可用时降级为进程内投递是可接受的——客户端重连后仍会全量对账。
4. **补发媒体完成事件**：图片描述 / 语音转写在事务提交后发布
   `conversation_updated`。
5. **SSE 帧补 `id` 字段**：为将来 `Last-Event-ID` 断线重放预留（重放本身未实现）。

## 不覆盖（后续项）

- **断线重放**：需要事务性 outbox（事件表 + 序号 + 重放端点）。当前靠「重连即
  对账」覆盖，客户端不会丢状态。
- **按用户/会话过滤**：SSE 目前把事件广播给所有已认证用户。载荷只有
  `type / conversationId / occurredAt / messageId`（无内容），客户端再按权限回拉，
  因此不是泄漏；团队与设备规模上来后值得加过滤。
- **多 api 实例**：Redis pub/sub 本身支持多订阅者，但 SSE 连接落在单个实例内；
  需要负载均衡粘性或改用 Redis Streams + 游标。

## 后果

- AI 回复、媒体转写完成秒级到达工作台；web 对账 60s→15s、mobile 详情 30s /
  列表 60s，轮询从「唯一实时手段」降为对账兜底。
- 事件在业务事务内发布：事务回滚会产生「幽灵事件」。因为客户端只做失效回拉，
  幽灵事件只导致一次空刷新，无害。
- 每个进程多两个 Redis 连接（发布 / 订阅各一）。Redis 不可用时前端退化为轮询，
  功能不中断。
