ALTER TABLE "conversation"."messages" ADD COLUMN "send_operation_id" varchar(128);--> statement-breakpoint
ALTER TABLE "conversation"."messages" ADD COLUMN "send_error" text;--> statement-breakpoint
ALTER TABLE "conversation"."messages" ADD COLUMN "send_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation"."messages" ADD CONSTRAINT "messages_channel_message_unique" UNIQUE("conversation_id","channel_message_id");
