-- Customer Support: AI Employees + 联系人绑定（业务专属 schema）。
-- 与 root AGENTS.md 一致：业务专属事实隔离在 customer_support schema，
-- 物理上不污染 core/conversation/handoff/agent 等平台域。
-- 写入路径仅由 weflow-solutions/solutions/customer-support/backend 的
-- registerRoutes 处理；core/modules 不直接读写这些表。

CREATE SCHEMA IF NOT EXISTS "customer_support";

CREATE TABLE "customer_support"."ai_employee_definitions" (
  "definition_id" varchar(200) PRIMARY KEY,
  "key" varchar(120) NOT NULL UNIQUE,
  "name" varchar(200) NOT NULL,
  "description" text,
  "status" varchar(20) NOT NULL DEFAULT 'active'
    CHECK ("status" IN ('active', 'archived')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "customer_support"."ai_employee_versions" (
  "version_id" varchar(200) PRIMARY KEY,
  "definition_id" varchar(200) NOT NULL
    REFERENCES "customer_support"."ai_employee_definitions"("definition_id")
    ON DELETE CASCADE,
  "version" integer NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'draft'
    CHECK ("status" IN ('draft', 'published', 'retired')),
  "prompt" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz,
  UNIQUE ("definition_id", "version")
);
CREATE INDEX IF NOT EXISTS "ai_employee_versions_definition_idx"
  ON "customer_support"."ai_employee_versions" ("definition_id");

-- 工作空间默认 AI Employee：单行表（id=1）
CREATE TABLE "customer_support"."ai_employee_workspace_default" (
  "id" smallint PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "default_definition_id" varchar(200)
    REFERENCES "customer_support"."ai_employee_definitions"("definition_id")
    ON DELETE SET NULL
);

-- 联系人显式绑定：解析顺序为「per-contact binding → workspace default → null」
CREATE TABLE "customer_support"."contact_agent_bindings" (
  "contact_id" varchar(600) PRIMARY KEY,
  "definition_id" varchar(200) NOT NULL
    REFERENCES "customer_support"."ai_employee_definitions"("definition_id")
    ON DELETE CASCADE,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
