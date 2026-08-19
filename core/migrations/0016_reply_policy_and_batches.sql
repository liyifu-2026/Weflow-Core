CREATE TABLE "agent"."reply_policy_versions" (
	"policy_version_id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"version" integer NOT NULL,
	"status" varchar(20) NOT NULL,
	"document" jsonb NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"published_by_user_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "reply_policy_versions_name_version_unique" UNIQUE("name", "version")
);
--> statement-breakpoint
CREATE INDEX "reply_policy_versions_status_idx" ON "agent"."reply_policy_versions" USING btree ("status");
--> statement-breakpoint
ALTER TABLE "agent"."turns" ADD COLUMN "reply_policy_version_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "agent"."turns" ADD COLUMN "response_segments" jsonb;
--> statement-breakpoint
ALTER TABLE "agent"."turns" ADD CONSTRAINT "turns_reply_policy_version_id_reply_policy_versions_policy_version_id_fk" FOREIGN KEY ("reply_policy_version_id") REFERENCES "agent"."reply_policy_versions"("policy_version_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation"."messages" ADD COLUMN "reply_batch_id" varchar(700);
--> statement-breakpoint
ALTER TABLE "conversation"."messages" ADD COLUMN "reply_sequence" integer;
--> statement-breakpoint
CREATE INDEX "messages_reply_batch_idx" ON "conversation"."messages" USING btree ("reply_batch_id", "reply_sequence");
