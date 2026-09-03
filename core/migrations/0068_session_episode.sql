-- 0068: 会话片段（Session Episode）+ 会话唤醒（Session Wake）
-- Phase 3 会话模式：代理的单位从「消息回合」升级为「会话片段」。
-- 连续性活在数据模型里，不活在进程里——waiting 会话只是一行记录，
-- 不占 worker/不烧 token；到点由 wake dispatcher 续轮或直发 nudge。
-- 约定（照 turn_admission/memory_capture 家法）：
--   * agent_sessions：一会话一行（active/waiting/closed + 预算计数 + revision）
--   * session_wakes：wait 决策的持久化唤醒计划，幂等键 turn_id
--     （同轮重复决策覆盖旧计划）；kind=wait_timeout 预承诺 nudge 由代码直发
CREATE TABLE agent.sessions (
  session_id VARCHAR(700) PRIMARY KEY,
  conversation_id VARCHAR(300) NOT NULL REFERENCES conversation.conversations(conversation_id),
  state VARCHAR(30) NOT NULL DEFAULT 'active',
  rounds_used INTEGER NOT NULL DEFAULT 0,
  round_budget INTEGER NOT NULL DEFAULT 24,
  started_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  closure_summary TEXT,
  inbox_watermark_message_id VARCHAR(600) REFERENCES conversation.messages(message_id),
  revision INTEGER NOT NULL DEFAULT 1,
  error_code VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_sessions_conversation_state_idx
  ON agent.sessions (conversation_id, state);

CREATE TABLE agent.session_wakes (
  wake_id BIGSERIAL PRIMARY KEY,
  conversation_id VARCHAR(300) NOT NULL REFERENCES conversation.conversations(conversation_id),
  turn_id VARCHAR(700) NOT NULL REFERENCES agent.turns(turn_id) ON DELETE CASCADE,
  kind VARCHAR(40) NOT NULL,             -- 'wait_timeout'（后续可扩 schedule/reminder）
  status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
  wake_at TIMESTAMPTZ NOT NULL,
  nudge_text TEXT,                        -- 预承诺话术；空=超时只收尾不发消息
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX agent_session_wakes_turn_unique ON agent.session_wakes (turn_id);
CREATE INDEX agent_session_wakes_status_wake_idx ON agent.session_wakes (status, wake_at);
