# ADR-0006：群聊引用回复与 @ 提及（reply / mention / poke）

## Status

Accepted — 2026-08-24（客服业务 Go-Live 前置）

## Problem

需求（owner 第 8 条）：客服群聊需要支持「引用消息回复」与「@ 群员回复」。
当前权威契约 `@weflow/contracts` 的 `ChannelSendPayload` 只有
text/file/image/voice 四种；旧树 `wxbot/weflow-server` 已有 reply/mention/
poke/recall/voice_call 的扩展契约（`channel-send-operations.ts`）与群聊
响应策略（`group-chat-policy.ts`），需要移植进当前仓库并打通 Core 链路。

## Decision

1. **权威契约扩展**（`packages/contracts/src/channel.ts`）：
   - `ChannelSendPayload` 增加：
     - `{ kind: "reply", text, replyToChannelMessageId }`
     - `{ kind: "mention", text, mentionContactRefs: string[] }`
     - `{ kind: "poke" }`（拍一拍）
   - `ChannelEvent` 增加可选 `mentioned?: boolean`（群聊中被 @ 标记）与
     `replyToChannelMessageId?: string | null`（入站引用）。
   全部 additive，旧 Host 不带时行为不变；按 AGENTS.md 第 6 条以本 ADR 记录。
2. **存储**：`messages` 表增加
   `reply_to_channel_message_id varchar(300)` 与 `mention_contact_refs jsonb`（默认 []）。
3. **群聊策略**：移植 `group-chat-policy.ts` 到 `core/modules/agent/application/`；
   Agent Turn 准入时对群聊会话应用策略（被 @ 必回、关键词可配、可概率回）；
   策略参数来源：Solution 配置（后续接入 execution profile 或 settings）。
4. **入站**：channel host 解析微信 XML 的引用/被 @ 状态，写入事件
   `mentioned` / `replyToChannelMessageId`；Core ingest 落库。
5. **出站**：`create-manual-reply` 与 agent 出站支持 reply/mention payload；
   Channel Host 负责合成微信 XML 发送。

## Scope

- 覆盖：契约、消息存储、入站解析、出站发送、群聊 Turn 准入策略。
- 不覆盖：@ 后自动拉人、群成员目录、@all；这些后续按 Solution 能力做。
- recall/voice_call 不移植（本次不做撤回与语音通话，避免扩大面）。

## Consequences

- 新迁移 `0059_message_reply_mention.sql`（journal 追加，不改写历史）。
- `create-manual-reply`/`process-outbound-messages`/`http-channel-provider`
  同步扩展；旧 Host 的 text 消息不受影响。
- Channel Host 需新增事件字段（任务 E 范围外补充：mentioned/replyTo 解析）。
- 测试补：群聊 @ 触发 Turn、引用出站 payload 形状。
