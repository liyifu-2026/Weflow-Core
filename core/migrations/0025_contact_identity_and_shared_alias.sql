ALTER TABLE "conversation"."contact_profiles" ADD COLUMN "channel_display_name" text;
--> statement-breakpoint
ALTER TABLE "conversation"."contact_profiles" ADD COLUMN "channel_nickname" text;
--> statement-breakpoint
ALTER TABLE "conversation"."contact_profiles" ADD COLUMN "channel_remark" text;
--> statement-breakpoint
ALTER TABLE "conversation"."contact_profiles" ADD COLUMN "channel_alias" text;
--> statement-breakpoint
ALTER TABLE "conversation"."contact_profiles" ADD COLUMN "avatar_url" text;
--> statement-breakpoint
ALTER TABLE "conversation"."contact_profiles" ADD COLUMN "shared_alias" text;
--> statement-breakpoint
ALTER TABLE "conversation"."contact_profiles" ADD COLUMN "alias_updated_by_user_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "conversation"."contact_profiles" ADD COLUMN "alias_updated_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "conversation"."contact_alias_events" (
  "event_id" varchar(36) PRIMARY KEY NOT NULL,
  "contact_id" varchar(600) NOT NULL,
  "actor_user_id" varchar(36) NOT NULL,
  "previous_alias" text,
  "next_alias" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation"."contact_alias_events" ADD CONSTRAINT "contact_alias_events_contact_fk" FOREIGN KEY ("contact_id") REFERENCES "conversation"."contact_profiles"("contact_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation"."contact_alias_events" ADD CONSTRAINT "contact_alias_events_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity"."users"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "contact_alias_events_contact_created_idx" ON "conversation"."contact_alias_events" USING btree ("contact_id", "created_at");
