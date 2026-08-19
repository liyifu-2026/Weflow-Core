ALTER TABLE "handoff"."events" ADD COLUMN "target_user_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "handoff"."events" ADD CONSTRAINT "handoff_events_target_user_fk" FOREIGN KEY ("target_user_id") REFERENCES "identity"."users"("user_id") ON DELETE no action ON UPDATE no action;
