# ADR-0005：多微信账号隔离（Channel account 维度）

## Status

Accepted — 2026-08-24（客服业务 Go-Live 前置）

## Problem

同一台机器可能登录多个微信账号（微信 4.x 多开）。此前 Channel Host 事件
只有 `conversationRef`（wxid/群 id），不同账号下相同 wxid 的联系人会合并到
同一个 contact/conversation，导致两个账号的消息混在一个会话里（线上曾发生）。
需求（owner 第 9 条）：底层必须区分账号，按 `(account, contact)` 隔离。

## Decision

1. **契约**：`@weflow/contracts` 的 `ChannelEvent` 增加可选字段
   `account?: string | null`。`null`/缺省 = 平台默认账号 `default`。
   `ChannelContact` 同理增加 `account`。这是 additive 变更（旧 Host 不带
   account 时行为与现在完全一致），不破坏既有 wire shape，但按
   `core/AGENTS.md` 第 6 条以本 ADR 记录。
2. **存储**：
   - `contact_profiles` 增加 `channel_account varchar(64) NOT NULL DEFAULT 'default'`，
     唯一键改为 `(channel, channel_account, channel_contact_id)`。
   - `conversations` 增加 `channel_account varchar(64) NOT NULL DEFAULT 'default'`。
   - `channel_cursors.source` 保持 `channel-host`（游标按 host 全局推进，host
     单实例；多 host 实例时 source 由部署方带后缀）。
3. **ID 派生**：`contactIdForChannel(channel, account, channelContactId)` →
   `contact:${channel}:${account}:${channelContactId}`；
   conversationId 同理 `channel:${account}:${conversationRef}`。
   旧数据 account='default'，ID 形态变化只影响新摄入，不回写历史。
4. **发送侧**：Channel Send 的 `conversationRef` 必须携带 account（由
   conversations 行读出），Host 按 account 选择微信实例发消息。
5. **Channel Host（wechatauto）**：事件增加 `account` 字段（对应
   `WECHAT_ACCOUNT` 环境变量/账号目录），发送操作绑定账号实例。

## Scope

- 覆盖：事件摄取、联系人同步、会话查询、消息落库、出站发送。
- 不覆盖：本 ADR 不改变 agent 策略、记忆、知识、handoff 语义；
  群聊 senderRef 的解析仍由 Host 负责。
- mobile/console 工作台按 account 显示会话（账户切换由 UI 层后续做）。

## Consequences

- 新增迁移 `0057_channel_account.sql`（journal 追加一行，不改写历史）。
- `contact_profiles`/`conversations` 唯一性与索引变化需跑迁移并验证。
- 测试补：两个 account 相同 wxid 不串会话的集成测试。
- Channel Host 事件 schema 增加 account 后，旧 host 仍兼容（缺省 default）。
