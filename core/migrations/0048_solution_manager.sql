-- Solution Installation state machine for Phase 7.
CREATE SCHEMA IF NOT EXISTS "solution";
--> statement-breakpoint
CREATE TABLE "solution"."installations" (
  "solution_id" varchar(200) PRIMARY KEY,
  "version" varchar(50) NOT NULL,
  "desired_state" varchar(20) NOT NULL DEFAULT 'disabled',
  "observed_state" varchar(20) NOT NULL DEFAULT 'absent',
  "health_state" varchar(20) NOT NULL DEFAULT 'unknown',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "solution"."versions" (
  "solution_id" varchar(200) NOT NULL,
  "version" varchar(50) NOT NULL,
  "manifest_digest" varchar(80) NOT NULL,
  "lock_digest" varchar(80) NOT NULL,
  "signature_key_id" varchar(200),
  "status" varchar(20) NOT NULL DEFAULT 'installed',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("solution_id", "version")
);
--> statement-breakpoint
CREATE TABLE "solution"."operations" (
  "operation_id" varchar(100) PRIMARY KEY,
  "solution_id" varchar(200) NOT NULL,
  "type" varchar(20) NOT NULL,
  "state" varchar(20) NOT NULL,
  "idempotency_key" varchar(200) NOT NULL UNIQUE,
  "plan_digest" varchar(80),
  "attempt" integer DEFAULT 0 NOT NULL,
  "claimed_at" timestamp with time zone,
  "lease_until" timestamp with time zone,
  "checkpoint" varchar(200),
  "error_code" varchar(100),
  "actor" varchar(200) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "solution"."resource_ownership" (
  "resource_id" varchar(300) NOT NULL,
  "solution_id" varchar(200) NOT NULL,
  "resource_type" varchar(50) NOT NULL,
  "resource_ref" varchar(500) NOT NULL,
  "archived_at" timestamp with time zone,
  PRIMARY KEY ("resource_id", "solution_id")
);
--> statement-breakpoint
CREATE TABLE "solution"."events" (
  "event_id" varchar(100) PRIMARY KEY,
  "solution_id" varchar(200) NOT NULL,
  "operation_id" varchar(100),
  "event_type" varchar(60) NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "solution_operations_state_idx" ON "solution"."operations" USING btree ("state");
--> statement-breakpoint
CREATE INDEX "solution_operations_solution_idx" ON "solution"."operations" USING btree ("solution_id");
--> statement-breakpoint
CREATE INDEX "solution_events_solution_created_idx" ON "solution"."events" USING btree ("solution_id", "created_at");
