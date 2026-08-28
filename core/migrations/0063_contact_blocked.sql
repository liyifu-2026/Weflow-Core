-- 联系人黑名单：blocked 联系人不建 Agent Turn、不出现在会话列表、不推通知；
-- 消息照常入库（留证据），只能在联系人页查看。
ALTER TABLE "conversation"."contact_profiles" ADD COLUMN "blocked" boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "contact_profiles_blocked_idx"
  ON "conversation"."contact_profiles" ("blocked")
  WHERE "blocked" = true;
