-- 0072: 通知类型订阅（Mobile 通知设置）
-- 移动端设置页要求两类通知可分别开关：
--   * handoff_pending  —— 有会话等待处理（进入等待人工队列 / 转交）
--   * assignee_inbound —— 我处理中的会话有客户新回复（5 分钟去重桶）
-- 约定：
--   * devices.notify_kinds：NULL 或空数组 = 全部订阅（旧行/未传场景默认全开）；
--     非空数组 = 仅订阅列出的类型。dispatcher 按 kind 过滤。
--   * outbox.kind 的取值即订阅键，不另设映射层。
ALTER TABLE notification.devices
  ADD COLUMN notify_kinds JSONB;
