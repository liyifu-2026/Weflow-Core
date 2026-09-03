-- 0065: 会话级 TTL（移动端长时效登录）
-- 平台默认会话仍为 12h；移动端登录创建 30 天会话（identity-service MOBILE_SESSION_TTL_MS），
-- 并通过"活跃即续期"滑动过期：每次成功认证若剩余寿命低于一半则自动延长。
ALTER TABLE identity.user_sessions
  ADD COLUMN ttl_ms BIGINT;
