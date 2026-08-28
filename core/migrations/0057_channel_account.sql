-- ADR-0005: 多微信账号隔离（channel account 维度）
-- contact_profiles 与 conversations 增加 channel_account 列；
-- 唯一键扩展到 (channel, channel_account, channel_contact_id)。

ALTER TABLE "conversation"."contact_profiles"
  ADD COLUMN IF NOT EXISTS "channel_account" varchar(64) NOT NULL DEFAULT 'default';

ALTER TABLE "conversation"."conversations"
  ADD COLUMN IF NOT EXISTS "channel_account" varchar(64) NOT NULL DEFAULT 'default';

-- 重建唯一键：先删旧约束（若存在），再建新约束
ALTER TABLE "conversation"."contact_profiles"
  DROP CONSTRAINT IF EXISTS "contact_profiles_channel_identity_unique";

ALTER TABLE "conversation"."contact_profiles"
  ADD CONSTRAINT "contact_profiles_channel_identity_unique"
  UNIQUE ("channel", "channel_account", "channel_contact_id");
