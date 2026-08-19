CREATE TABLE "memory"."events" (
	"event_id" varchar(100) PRIMARY KEY NOT NULL,
	"memory_id" varchar(100) NOT NULL,
	"actor_user_id" varchar(36),
	"event_type" varchar(30) NOT NULL,
	"client_request_id" varchar(36),
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_client_request_id_unique" UNIQUE("client_request_id")
);
--> statement-breakpoint
ALTER TABLE "memory"."capture_states" ADD COLUMN "last_captured_message_id" varchar(600);--> statement-breakpoint
ALTER TABLE "memory"."capture_states" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory"."capture_states" ADD COLUMN "error_code" varchar(100);--> statement-breakpoint
ALTER TABLE "memory"."capture_states" ADD COLUMN "extracted_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory"."capture_states" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memory"."events" ADD CONSTRAINT "events_memory_id_memories_memory_id_fk" FOREIGN KEY ("memory_id") REFERENCES "memory"."memories"("memory_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_events_memory_created_idx" ON "memory"."events" USING btree ("memory_id","created_at");--> statement-breakpoint
ALTER TABLE "memory"."capture_states" ADD CONSTRAINT "capture_states_last_captured_message_id_messages_message_id_fk" FOREIGN KEY ("last_captured_message_id") REFERENCES "conversation"."messages"("message_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_contact_key_idx" ON "memory"."memories" USING btree ("contact_id","kind","memory_key");--> statement-breakpoint
CREATE INDEX "memory_capture_status_schedule_idx" ON "memory"."capture_states" USING btree ("status","scheduled_at");