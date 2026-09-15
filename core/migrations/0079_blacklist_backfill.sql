-- 0079: 黑名单制收尾——白名单时代的「默认仅人工」联系人回到默认自动回复。
-- 0060 把新联系人默认设为 agent_enabled=false，因此历史上大量联系人从未被
-- 人工配置过（updated_by_user_id 为空）却停在「仅人工」。转黑名单制后这些
-- 行应回到默认 true；人工刻意设过「仅人工」的行（updated_by_user_id 非空）
-- 与已拉黑的行一律保留。
-- 幂等：可安全重跑。

UPDATE "conversation"."contact_profiles"
SET "agent_enabled" = true,
    "updated_at" = now()
WHERE "agent_enabled" = false
  AND "blocked" = false
  AND "updated_by_user_id" IS NULL;
