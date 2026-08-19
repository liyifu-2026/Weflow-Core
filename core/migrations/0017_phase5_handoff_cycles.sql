CREATE TABLE "handoff"."cycles" (
	"cycle_id" varchar(100) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(300) NOT NULL,
	"status" varchar(30) NOT NULL,
	"reason" text NOT NULL,
	"assigned_user_id" varchar(36),
	"created_by_user_id" varchar(36) NOT NULL,
	"resolved_by_user_id" varchar(36),
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handoff"."cycles" ADD CONSTRAINT "cycles_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "handoff_cycles_conversation_created_idx" ON "handoff"."cycles" USING btree ("conversation_id", "created_at");
--> statement-breakpoint
INSERT INTO "handoff"."cycles" ("cycle_id", "conversation_id", "status", "reason", "assigned_user_id", "created_by_user_id", "resolved_by_user_id", "resolution", "created_at", "accepted_at", "resolved_at", "updated_at")
SELECT 'legacy:' || md5("conversation_id"), "conversation_id", "status", "reason", "assigned_user_id", "created_by_user_id", "resolved_by_user_id", "resolution", "created_at", "accepted_at", "resolved_at", "updated_at"
FROM "handoff"."states";
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "cycle_id" varchar(100);
--> statement-breakpoint
UPDATE "handoff"."states" SET "cycle_id" = 'legacy:' || md5("conversation_id");
--> statement-breakpoint
ALTER TABLE "handoff"."states" ALTER COLUMN "cycle_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD CONSTRAINT "states_cycle_id_cycles_cycle_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "handoff"."cycles"("cycle_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "handoff"."events" ADD COLUMN "cycle_id" varchar(100);
--> statement-breakpoint
UPDATE "handoff"."events" AS event SET "cycle_id" = state."cycle_id"
FROM "handoff"."states" AS state
WHERE event."conversation_id" = state."conversation_id";
--> statement-breakpoint
ALTER TABLE "handoff"."events" ALTER COLUMN "cycle_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "handoff"."events" ADD CONSTRAINT "events_cycle_id_cycles_cycle_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "handoff"."cycles"("cycle_id") ON DELETE no action ON UPDATE no action;
