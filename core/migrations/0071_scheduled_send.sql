-- 0071: 定时发送（Scheduled Send）
-- SCHEDULED-SEND-PLAN（grill 8 项决策）：agent 在对话中约定未来的发送
-- （提醒/follow-up），到点由 dispatcher 走既有 send operation 链路直发，
-- 发送时不调用模型（预承诺直发家法）。agent 永不主动开口——这是唯一
-- 的"自主"通道，且必须有入站对话作为根。
-- 约定（照 session_wakes 家法）：
--   * agent.scheduled_sends：schedule_send 决策的持久化执行计划，
--     幂等键 scheduled_send_id = "scheduled:{turnId}"（一轮至多一条）
--   * 状态机 pending → fired | cancelled(new_inbound/superseded/operated)
--     | frozen(handoff 激活，人工放行/丢弃)
--   * contact_profiles.scheduled_send_enabled：联系人级开关，默认关
CREATE TABLE agent.scheduled_sends (
  scheduled_send_id VARCHAR(750) PRIMARY KEY,
  conversation_id VARCHAR(300) NOT NULL REFERENCES conversation.conversations(conversation_id),
  turn_id VARCHAR(700) NOT NULL REFERENCES agent.turns(turn_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  send_at TIMESTAMPTZ NOT NULL,
  fired_message_id VARCHAR(700),
  cancel_reason VARCHAR(60),
  operated_by_user_id VARCHAR(36),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_scheduled_sends_status_send_idx
  ON agent.scheduled_sends (status, send_at);

CREATE INDEX agent_scheduled_sends_conversation_status_idx
  ON agent.scheduled_sends (conversation_id, status);

ALTER TABLE conversation.contact_profiles
  ADD COLUMN scheduled_send_enabled BOOLEAN NOT NULL DEFAULT false;
