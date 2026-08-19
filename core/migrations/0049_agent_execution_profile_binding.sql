-- Agent Execution Profile binding for Phase 7 Agent Runtime generalization.
CREATE TABLE "agent"."execution_profiles" (
  "profile_id" varchar(100) PRIMARY KEY,
  "solution_id" varchar(200) NOT NULL,
  "solution_version" varchar(50) NOT NULL,
  "strategy_ref" varchar(200) NOT NULL,
  "strategy_version" varchar(50) NOT NULL,
  "max_model_calls" integer DEFAULT 2 NOT NULL,
  "max_tool_calls" integer DEFAULT 1 NOT NULL,
  "timeout_seconds" integer DEFAULT 60 NOT NULL,
  "allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent"."turns" ADD COLUMN "execution_profile_id" varchar(100);
--> statement-breakpoint
ALTER TABLE "agent"."turns" ADD CONSTRAINT "turns_execution_profile_id_fk" FOREIGN KEY ("execution_profile_id") REFERENCES "agent"."execution_profiles"("profile_id");
--> statement-breakpoint
CREATE INDEX "agent_execution_profiles_status_idx" ON "agent"."execution_profiles" USING btree ("status");
