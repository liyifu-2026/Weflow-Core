-- ADR-0006: 群聊引用回复与 @ 提及（reply / mention）
-- messages 增加 reply_to_channel_message_id 与 mention_contact_refs。

ALTER TABLE "conversation"."messages"
  ADD COLUMN IF NOT EXISTS "reply_to_channel_message_id" varchar(300);

ALTER TABLE "conversation"."messages"
  ADD COLUMN IF NOT EXISTS "mention_contact_refs" jsonb NOT NULL DEFAULT '[]'::jsonb;
