-- 决策模型 Phase 3：handoff 待认领队列的机制化优先级。
-- priority = 决策模型 urgency score（1..criteria 档数），NULL = 未评分
-- （打分失败/未启用 → 排序语义与今天一致）；priority_scored_at 供观测。
ALTER TABLE "handoff"."states"
  ADD COLUMN "priority" integer;
ALTER TABLE "handoff"."states"
  ADD COLUMN "priority_scored_at" timestamptz;
