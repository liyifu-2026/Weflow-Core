-- 0078: 联系人策略由白名单制改为黑名单制。
-- 0060 曾把 agent_enabled 默认值改为 false（新联系人默认「仅人工」，需
-- 管理员逐个放行）；本迁移改回 true：新联系人默认由 AI 接待，用
-- blocked=true 拉黑，或用 agent_enabled=false 单独设为「仅人工」。
-- 存量行不动：已有的 false 是人工刻意设置，保持原样。
-- 幂等：可安全重跑。

ALTER TABLE "conversation"."contact_profiles"
  ALTER COLUMN "agent_enabled" SET DEFAULT true;
