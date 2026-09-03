-- 0067: 合并窗口（Turn Admission）
-- 回合准入改造（Phase 1）：客户连发多条消息不再逐条建 Agent Turn，
-- 而是先登记进本会话的合并窗口；静默足够久（默认 12s，半句未完最长
-- 30s）才由 dispatcher 合并窗内消息建一个 Turn，消灭抢答。
-- 约定（照 memory.capture_states 家法）：
--   * 一会话一行（conversation_id PK），新消息 upsert 重置窗口 revision+1
--   * status: scheduled -> dispatching -> done/failed；CAS 认领防多实例重复建 turn
--   * last_message_id 为收窗水位（窗内最后一条入站消息），建 turn 时作 trigger
CREATE TABLE agent.turn_admission_states (
  conversation_id VARCHAR(300) PRIMARY KEY REFERENCES conversations.conversations(conversation_id),
  contact_id VARCHAR(600) NOT NULL REFERENCES contacts.contact_profiles(contact_id),
  last_message_id VARCHAR(600) NOT NULL REFERENCES conversations.messages(message_id),
  message_count INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
  scheduled_at TIMESTAMPTZ NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  error_code VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_turn_admission_status_schedule_idx
  ON agent.turn_admission_states (status, scheduled_at);
