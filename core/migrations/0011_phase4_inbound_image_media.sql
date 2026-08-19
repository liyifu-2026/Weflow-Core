CREATE SCHEMA "media";
--> statement-breakpoint
CREATE TABLE "media"."assets" (
	"media_id" varchar(100) PRIMARY KEY NOT NULL,
	"message_id" varchar(600) NOT NULL,
	"conversation_id" varchar(300) NOT NULL,
	"source_conversation_id" varchar(256) NOT NULL,
	"source_local_id" bigint NOT NULL,
	"kind" varchar(30) NOT NULL,
	"status" varchar(30) DEFAULT 'queued' NOT NULL,
	"original_file_id" varchar(36),
	"attempt" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(100),
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_message_unique" UNIQUE("message_id"),
	CONSTRAINT "media_assets_source_unique" UNIQUE("source_conversation_id","source_local_id")
);
--> statement-breakpoint
ALTER TABLE "media"."assets" ADD CONSTRAINT "assets_message_id_messages_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "conversation"."messages"("message_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."assets" ADD CONSTRAINT "assets_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."assets" ADD CONSTRAINT "assets_original_file_id_files_file_id_fk" FOREIGN KEY ("original_file_id") REFERENCES "file_storage"."files"("file_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_status_retry_idx" ON "media"."assets" USING btree ("status","next_attempt_at");