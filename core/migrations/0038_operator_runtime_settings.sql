CREATE SCHEMA IF NOT EXISTS "operations";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operations"."runtime_settings" (
  "key" varchar(50) PRIMARY KEY,
  "value" text NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "updated_by" varchar(100)
);
--> statement-breakpoint
INSERT INTO "operations"."runtime_settings" ("key", "value")
VALUES
  ('agent_enabled', 'true'),
  ('auto_send_enabled', 'true'),
  ('knowledge_enabled', 'true'),
  ('memory_enabled', 'true'),
  ('vision_enabled', 'true'),
  ('text_model', 'deepseek-v4-flash'),
  ('vision_model', 'mimo-v2.5')
ON CONFLICT ("key") DO NOTHING;
