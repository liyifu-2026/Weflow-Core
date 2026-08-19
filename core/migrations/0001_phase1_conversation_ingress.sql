CREATE SCHEMA "conversation";
--> statement-breakpoint
CREATE TABLE "conversation"."channel_cursors" (
	"source" varchar(50) PRIMARY KEY NOT NULL,
	"cursor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation"."conversations" (
	"conversation_id" varchar(300) PRIMARY KEY NOT NULL,
	"channel" varchar(50) NOT NULL,
	"channel_conversation_id" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation"."messages" (
	"message_id" varchar(600) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(300) NOT NULL,
	"channel_event_id" varchar(600) NOT NULL,
	"channel_message_id" varchar(300) NOT NULL,
	"direction" varchar(20) NOT NULL,
	"actor_type" varchar(30) NOT NULL,
	"actor_id" varchar(256),
	"content_type" varchar(50) NOT NULL,
	"channel_type" integer NOT NULL,
	"text" text NOT NULL,
	"is_self" boolean,
	"processing_state" varchar(30) NOT NULL,
	"send_state" varchar(30),
	"idempotency_key" varchar(600) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trace_id" varchar(700) NOT NULL,
	CONSTRAINT "messages_channel_event_unique" UNIQUE("channel_event_id")
);
--> statement-breakpoint
ALTER TABLE "conversation"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_conversation_occurred_idx" ON "conversation"."messages" USING btree ("conversation_id","occurred_at");