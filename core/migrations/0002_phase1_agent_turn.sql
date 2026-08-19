CREATE SCHEMA "agent";
--> statement-breakpoint
CREATE TABLE "agent"."turns" (
	"turn_id" varchar(700) PRIMARY KEY NOT NULL,
	"trigger_message_id" varchar(600) NOT NULL,
	"conversation_id" varchar(300) NOT NULL,
	"status" varchar(30) NOT NULL,
	"model" varchar(100),
	"response_text" text,
	"error_code" varchar(100),
	"attempt" integer DEFAULT 0 NOT NULL,
	"trace_id" varchar(700) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_turns_trigger_message_unique" UNIQUE("trigger_message_id")
);
--> statement-breakpoint
ALTER TABLE "conversation"."messages" ALTER COLUMN "channel_event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation"."messages" ALTER COLUMN "channel_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent"."turns" ADD CONSTRAINT "turns_trigger_message_id_messages_message_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "conversation"."messages"("message_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent"."turns" ADD CONSTRAINT "turns_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_turns_status_created_idx" ON "agent"."turns" USING btree ("status","created_at");
