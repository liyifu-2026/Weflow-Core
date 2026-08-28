-- 白名单模式：新联系人默认不触发 Agent 对话（agent_enabled 默认 false）。
-- 存量 true 保留（已有白名单语义），只影响未来新建的 contact_profiles 行。
ALTER TABLE "conversation"."contact_profiles"
  ALTER COLUMN "agent_enabled" SET DEFAULT false;
