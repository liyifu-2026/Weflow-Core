-- 0073: 模型注册表增加 protocol 字段（ASR 端点协议分流）。
-- asr 能力模型存在两种端点协议：
--   chat_inline        — chat/completions + input_audio 内联（MiMo 语音）
--   audio_transcriptions — 标准 multipart audio/transcriptions（OpenAI 兼容，如硅基流动）
-- 缺省 chat_inline 保持既有条目行为不变。
ALTER TABLE "operations"."model_registry"
  ADD COLUMN "protocol" varchar(30) NOT NULL DEFAULT 'chat_inline';
