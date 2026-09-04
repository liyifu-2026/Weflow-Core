-- 0069: 模型网关（R2 设置中心 · 模型分区）。
-- 统一模型注册表：模型 = 名称 + 端点 + 密钥 + 能力标签（文本/视觉/语音）
-- + 故障转移链（主模型失败/超时按序切备）。轻量内建，不引外部依赖；
-- 复用既有 runtime_settings 的 hot-reload 模式（model-settings-hot）。
--
-- 存储在 operations 模块（平台级、业务中立）：模型注册表是平台能力，
-- Solution 只按槽位名消费（text/vision/asr/triage/fast）。
CREATE TABLE "operations"."model_registry" (
  "model_id" varchar(120) PRIMARY KEY,
  "display_name" varchar(200) NOT NULL,
  "base_url" text NOT NULL,
  "api_key" text,
  "capabilities" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "timeout_ms" integer NOT NULL DEFAULT 60000,
  "failover_to" varchar(120)
    REFERENCES "operations"."model_registry"("model_id")
    ON DELETE SET NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" varchar(100)
);
CREATE INDEX IF NOT EXISTS "model_registry_enabled_idx"
  ON "operations"."model_registry" ("enabled");
