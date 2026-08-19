-- Durable ToolExecution lease for cross-worker recovery.
ALTER TABLE "agent"."tool_executions"
  ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent"."tool_executions"
  ADD COLUMN "claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent"."tool_executions"
  ADD COLUMN "lease_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "tool_executions_lease_idx"
  ON "agent"."tool_executions" USING btree ("status", "lease_until");
