ALTER TABLE "conversation"."conversations" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "conversation"."conversations" AS c SET "revision" = (
  SELECT count(*)::integer FROM "conversation"."messages" AS m
  WHERE m."conversation_id" = c."conversation_id" AND m."actor_type" <> 'system'
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "conversation"."increment_conversation_revision"() RETURNS trigger AS $$
BEGIN
  IF NEW."actor_type" = 'system' THEN
    RETURN NEW;
  END IF;
  UPDATE "conversation"."conversations"
  SET "revision" = "revision" + 1
  WHERE "conversation_id" = NEW."conversation_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "messages_increment_conversation_revision"
AFTER INSERT ON "conversation"."messages"
FOR EACH ROW EXECUTE FUNCTION "conversation"."increment_conversation_revision"();
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD COLUMN "contract_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD COLUMN "handoff_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD COLUMN "transfer_context" jsonb;
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD COLUMN "result" varchar(40);
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD COLUMN "resolution_summary" jsonb;
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD COLUMN "customer_constraints" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD COLUMN "transferred_by_user_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD COLUMN "target_type" varchar(12);
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD COLUMN "target_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD COLUMN "finished_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "contract_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "handoff_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "target_user_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "target_queue_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "transferred_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "pending_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "accept_by" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "fallback_queue_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "result" varchar(40);
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "resolution_summary" jsonb;
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "finished_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "handoff"."events" ADD COLUMN "request_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "handoff"."events" ADD COLUMN "response_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "handoff"."events" ADD COLUMN "outcome_status" varchar(20) DEFAULT 'succeeded' NOT NULL;
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD CONSTRAINT "handoff_states_target_user_fk" FOREIGN KEY ("target_user_id") REFERENCES "identity"."users"("user_id");
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD CONSTRAINT "handoff_states_target_queue_fk" FOREIGN KEY ("target_queue_id") REFERENCES "collaboration"."specialist_queues"("queue_id");
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD CONSTRAINT "handoff_states_fallback_queue_fk" FOREIGN KEY ("fallback_queue_id") REFERENCES "collaboration"."specialist_queues"("queue_id");
--> statement-breakpoint
CREATE TABLE "handoff"."resolution_summary_jobs" (
  "job_id" varchar(100) PRIMARY KEY NOT NULL,
  "conversation_id" varchar(300) NOT NULL,
  "cycle_id" varchar(100) NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "error_code" varchar(100),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "handoff_resolution_jobs_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id"),
  CONSTRAINT "handoff_resolution_jobs_cycle_fk" FOREIGN KEY ("cycle_id") REFERENCES "handoff"."cycles"("cycle_id")
);
--> statement-breakpoint
CREATE INDEX "handoff_resolution_jobs_status_idx" ON "handoff"."resolution_summary_jobs" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE TABLE "handoff"."quality_feedback" (
  "feedback_id" varchar(100) PRIMARY KEY NOT NULL,
  "conversation_id" varchar(300) NOT NULL,
  "cycle_id" varchar(100) NOT NULL,
  "message_id" varchar(600),
  "actor_user_id" varchar(36) NOT NULL,
  "kind" varchar(40) NOT NULL,
  "brief_version" integer,
  "client_request_id" varchar(36) NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "handoff_quality_feedback_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id"),
  CONSTRAINT "handoff_quality_feedback_cycle_fk" FOREIGN KEY ("cycle_id") REFERENCES "handoff"."cycles"("cycle_id"),
  CONSTRAINT "handoff_quality_feedback_message_fk" FOREIGN KEY ("message_id") REFERENCES "conversation"."messages"("message_id"),
  CONSTRAINT "handoff_quality_feedback_user_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity"."users"("user_id")
);
--> statement-breakpoint
CREATE INDEX "handoff_quality_feedback_cycle_idx" ON "handoff"."quality_feedback" USING btree ("cycle_id", "created_at");
--> statement-breakpoint
ALTER TABLE "notification"."outbox" DROP CONSTRAINT "outbox_user_id_users_user_id_fk";
--> statement-breakpoint
ALTER TABLE "notification"."outbox" ADD CONSTRAINT "outbox_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE cascade;
--> statement-breakpoint
INSERT INTO "collaboration"."specialist_queues" ("queue_id", "key", "display_name", "description")
VALUES ('queue-general', 'general_handoff', '通用人工队列', '无法确定专业归属时的人工接管兜底队列')
ON CONFLICT ("key") DO NOTHING;
