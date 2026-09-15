-- 0076: 会话类型成为 Channel 事实（ADR-0010）。
-- 此前群聊判定散布 6+ 处、各自从 channel_conversation_id 的 @chatroom
-- 后缀实时推导（协议 v6 起 Host 上报 conversationKind，ingest 落库定一次，
-- 后缀知识收敛至 ingest 单点；消费方一律读本列）。
-- 全部语句幂等：可安全重跑（对齐既有手工迁移的容错习惯）。

ALTER TABLE "conversation"."conversations"
  ADD COLUMN IF NOT EXISTS "chat_type" varchar(16) NOT NULL DEFAULT 'private';

-- 存量行按后缀一次性回填（此后新行由 ingest 写入）
UPDATE "conversation"."conversations"
SET "chat_type" = 'group'
WHERE "channel_conversation_id" LIKE '%@chatroom'
  AND "chat_type" <> 'group';
