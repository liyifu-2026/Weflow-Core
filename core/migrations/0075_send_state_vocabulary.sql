-- 0075: 发送状态词汇表落地 —— messages.send_state 收敛为受约束的 8 态全集。
-- 此前该列是无约束 varchar，实际持久态散布 9+ 个且三处消费漂移
-- （confirmed 报成 accepted、round-window 漏 submitting、前端渲染幻影态）。
-- 权威定义见 modules/conversations/application/send-states.ts。

-- 1) 合并同义取消态：cancelled_handoff / cancelled_policy 无任何消费方区分，
--    原因一直都在 send_error 里（handoff_active / contact_blocked / agent_disabled）。
UPDATE "conversation"."messages"
SET "send_state" = 'cancelled'
WHERE "send_state" IN ('cancelled_handoff', 'cancelled_policy');

-- 2) 归一历史幻影态（从未有写入方，仅防存量脏行使 CHECK 迁移失败）。
UPDATE "conversation"."messages" SET "send_state" = 'confirmed' WHERE "send_state" = 'sent';
UPDATE "conversation"."messages" SET "send_state" = 'pending' WHERE "send_state" = 'sending';

-- 3) CHECK 约束锁死全集：未来的状态漂移在写入时即失败，而非在消费端静默分叉。
ALTER TABLE "conversation"."messages" ADD CONSTRAINT "messages_send_state_check"
  CHECK (
    "send_state" IS NULL
    OR "send_state" IN (
      'pending', 'submitting', 'observed', 'confirmed',
      'failed', 'unknown', 'held', 'cancelled'
    )
  );
