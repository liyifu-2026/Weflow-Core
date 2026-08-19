CREATE SCHEMA IF NOT EXISTS "evaluation";
--> statement-breakpoint
CREATE TABLE "agent"."turn_events" (
	"event_id" varchar(700) PRIMARY KEY NOT NULL,
	"turn_id" varchar(700) NOT NULL,
	"conversation_id" varchar(300) NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"reason_code" varchar(120),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent"."turn_events" ADD CONSTRAINT "turn_events_turn_id_turns_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "agent"."turns"("turn_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "agent"."turn_events" ADD CONSTRAINT "turn_events_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id");
--> statement-breakpoint
CREATE INDEX "agent_turn_events_turn_created_idx" ON "agent"."turn_events" USING btree ("turn_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_turn_events_conversation_created_idx" ON "agent"."turn_events" USING btree ("conversation_id","created_at");
--> statement-breakpoint
CREATE TABLE "evaluation"."cases" (
	"case_id" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"zone" varchar(30) NOT NULL,
	"source_type" varchar(40) NOT NULL,
	"source_ref" text,
	"source_hash" varchar(128),
	"input" jsonb NOT NULL,
	"expected" jsonb NOT NULL,
	"redaction_status" varchar(30) NOT NULL,
	"status" varchar(30) NOT NULL,
	"created_by_user_id" varchar(36),
	"reviewed_by_user_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "evaluation"."cases" ADD CONSTRAINT "evaluation_cases_created_by_user_id_users_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "identity"."users"("user_id");
--> statement-breakpoint
ALTER TABLE "evaluation"."cases" ADD CONSTRAINT "evaluation_cases_reviewed_by_user_id_users_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "identity"."users"("user_id");
--> statement-breakpoint
CREATE TABLE "evaluation"."runs" (
	"run_id" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"policy_version_id" varchar(36),
	"zone" varchar(30) NOT NULL,
	"status" varchar(30) NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "evaluation"."runs" ADD CONSTRAINT "evaluation_runs_policy_version_id_reply_policy_versions_policy_version_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "agent"."reply_policy_versions"("policy_version_id");
--> statement-breakpoint
ALTER TABLE "evaluation"."runs" ADD CONSTRAINT "evaluation_runs_created_by_user_id_users_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "identity"."users"("user_id");
--> statement-breakpoint
CREATE TABLE "evaluation"."results" (
	"result_id" varchar(120) PRIMARY KEY NOT NULL,
	"run_id" varchar(100) NOT NULL,
	"case_id" varchar(100) NOT NULL,
	"action" varchar(30),
	"passed" boolean,
	"scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" jsonb,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_results_run_case_unique" UNIQUE("run_id","case_id")
);
--> statement-breakpoint
ALTER TABLE "evaluation"."results" ADD CONSTRAINT "evaluation_results_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "evaluation"."runs"("run_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "evaluation"."results" ADD CONSTRAINT "evaluation_results_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "evaluation"."cases"("case_id");
--> statement-breakpoint
CREATE TABLE "evaluation"."annotations" (
	"annotation_id" varchar(100) PRIMARY KEY NOT NULL,
	"result_id" varchar(120) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"verdict" varchar(30) NOT NULL,
	"corrected_action" varchar(30),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation"."annotations" ADD CONSTRAINT "evaluation_annotations_result_id_results_result_id_fk" FOREIGN KEY ("result_id") REFERENCES "evaluation"."results"("result_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "evaluation"."annotations" ADD CONSTRAINT "evaluation_annotations_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id");
