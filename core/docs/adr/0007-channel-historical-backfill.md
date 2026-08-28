# ADR 0007：空库历史回溯（Channel Backfill）

- 状态：已接受（2026-08-28）
- 关联：ADR-0005（多账号隔离）、ADR-0006（群聊响应策略）

## 背景

Channel Host 的消息链路是纯增量的：Core 通过 `channel.events` 水位增量摄取，
Host 以 `source_checkpoints`（conversation_ref → sort_seq）为水位捕获。
Host `bootstrap()` 的既有语义是「首启只占坑、不回溯历史」——Core 数据库为空
（首次启动/清库重建）时，历史会话与消息全部丢失，客户历史无法被 AI 与人工利用。

## 决策

1. **回溯在 Channel Host 侧完成，Core 无感知**。Host 检测空库信号：
   `channel_events` 与 `source_checkpoints` 双空（store 纪元内无任何捕获）且
   `historical_backfill` 标记未置时，自动执行一次性回溯；另提供
   `POST /api/v1/channel/backfill`（Bearer 鉴权；`{"force": true}` 可对非空
   store 重跑）。
2. **协议增量**：`ChannelEvent` 新增可选 `historical?: boolean | null`
   （本 ADR，protocolVersion 2）；随后协议演进至 v3（移除未实现的出站 voice
   发送能力，与本 ADR 无关）。仅增量字段，v1 Host 与 Core 互通兼容。
3. **Core 摄取安全边界**：`historical=true` 的事件照常入库（会话/消息/方向/
   processing_state=received），但跳过全部副作用——Agent Turn（含 Execution
   Profile 准入解析）、记忆捕获调度、assignee 通知 outbox、媒体资产转写排队
   （mediaAssets 不建行，不做 ASR/图片描述）、global-pause 人工路径。
   媒体消息内容为文本占位（`[图片]`/`[语音]`/文件名）。
4. **并发安全**：回溯开始前先把每个会话的 `source_checkpoints` 「占坑」到当前
   最大 sort_seq，并同步 discovery 指纹——增量轮询只捕获占坑之后的新消息；
   回溯事件 eventId 用稳定格式 `hist:<conversation_ref>:<local_id>`，
   与增量事件 `wechat:<conversation_ref>:<local_id>` 天然隔离，重复回溯靠
   event_id 幂等兜底。
5. **分批限速**：默认每批 200 条、批间 500ms（`WECHAT_BACKFILL_BATCH_SIZE` /
   `WECHAT_BACKFILL_BATCH_DELAY_MS`），范围可配
   `WECHAT_BACKFILL_INCLUDE_GROUPS`（默认 0，仅私聊）与
   `WECHAT_BACKFILL_SINCE_DAYS`（默认 30，0=不限）。
6. **绝不外发**：回溯全程不创建 send operation、不调用 GUI、不触碰发送链路。

## 事件 ID 语义（不破坏既有游标契约）

`hist:` 前缀事件是新的稳定标识空间；`channel_events.event_id` 唯一约束与
Core `messages.idempotency_key` 语义不变。cursor 仍全局递增（AUTOINCREMENT）。

## 「立即同步」端点语义变更（2026-08-28 追记）

`POST /api/v1/channel/sync`（及其 Core 代理 `/api/v1/admin/channel/sync`）
从「水位归零 + 实时重扫」改为**复用本回溯通道**（force 语义，202 立即返回）：

- 旧行为风险：重置水位后增量轮询把补到的历史消息当**实时事件**摄取，
  触发 Agent Turn / 记忆 / 通知，AI 可能回复一条陈年旧消息。
- 新行为：回溯按 `hist:` eventId 合成事件，Core 摄取零副作用；回溯前先
  查每会话已捕获的 `channel_message_id` 集合并跳过（`message_ids_for_
  conversation`），只补真正的漏捕消息，不为已入库消息造冗余事件。
- 实测（真实环境）：一次同步 rescue 出 100 条此前从未捕获的历史消息
  （store 91 → 191，Core 消息 110 → 210），0 条 Turn、0 条外发。

## 后果

- Core 清库 + Host 换新 store 重启后，微信历史自动回溯入库；重复触发幂等。
- 实时链路行为完全不变（v1 事件无 `historical` 字段，Core 视为实时事件）。
- 回溯的历史消息不产生任何 Turn/记忆/通知/媒体处理成本；AI 的历史感知由
  会话上下文自然覆盖（消息表按 occurred_at 排序）。
