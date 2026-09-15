-- 0074: 会话事实卡（私聊批）——每个会话一份持久工作状态。
-- 由模型随决策的 facts_card 字段全量更新（咨询性上下文，非事务事实），
-- 下一回合开头注入上下文头部，解决 20 条窗口装不下长周期服务史的问题。
CREATE TABLE IF NOT EXISTS "agent"."fact_cards" (
  "conversation_id" varchar(300) PRIMARY KEY REFERENCES "conversation"."conversations"("conversation_id"),
  "card" jsonb NOT NULL DEFAULT '{}',
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
