CREATE TABLE "conversation"."contact_profiles" (
	"contact_id" varchar(600) PRIMARY KEY NOT NULL,
	"channel" varchar(50) NOT NULL,
	"channel_contact_id" varchar(256) NOT NULL,
	"note" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_enabled" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_profiles_channel_identity_unique" UNIQUE("channel","channel_contact_id")
);
--> statement-breakpoint
INSERT INTO "conversation"."contact_profiles"
	("contact_id", "channel", "channel_contact_id")
SELECT
	'contact:' || "channel" || ':' || "channel_conversation_id",
	"channel",
	"channel_conversation_id"
FROM "conversation"."conversations"
ON CONFLICT ("channel", "channel_contact_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "conversation"."conversations" ADD COLUMN "contact_id" varchar(600);--> statement-breakpoint
UPDATE "conversation"."conversations"
SET "contact_id" = 'contact:' || "channel" || ':' || "channel_conversation_id";--> statement-breakpoint
ALTER TABLE "conversation"."conversations" ALTER COLUMN "contact_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation"."conversations" ADD CONSTRAINT "conversations_contact_id_contact_profiles_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "conversation"."contact_profiles"("contact_id") ON DELETE no action ON UPDATE no action;
