CREATE SCHEMA "memory";
--> statement-breakpoint
CREATE TABLE "memory"."memories" (
	"memory_id" varchar(100) PRIMARY KEY NOT NULL,
	"contact_id" varchar(600) NOT NULL,
	"kind" varchar(30) NOT NULL,
	"memory_key" varchar(100) NOT NULL,
	"content" text NOT NULL,
	"status" varchar(30) NOT NULL,
	"confidence" integer NOT NULL,
	"evidence_message_ids" jsonb NOT NULL,
	"extracted_by_model" varchar(100) NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory"."capture_states" (
	"conversation_id" varchar(300) PRIMARY KEY NOT NULL,
	"contact_id" varchar(600) NOT NULL,
	"watermark_message_id" varchar(600) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" varchar(30) DEFAULT 'scheduled' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory"."memories" ADD CONSTRAINT "memories_contact_id_contact_profiles_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "conversation"."contact_profiles"("contact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory"."capture_states" ADD CONSTRAINT "capture_states_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory"."capture_states" ADD CONSTRAINT "capture_states_contact_id_contact_profiles_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "conversation"."contact_profiles"("contact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory"."capture_states" ADD CONSTRAINT "capture_states_watermark_message_id_messages_message_id_fk" FOREIGN KEY ("watermark_message_id") REFERENCES "conversation"."messages"("message_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_contact_status_idx" ON "memory"."memories" USING btree ("contact_id","status");