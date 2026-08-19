CREATE SCHEMA "handoff";
--> statement-breakpoint
CREATE TABLE "handoff"."events" (
	"event_id" varchar(100) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(300) NOT NULL,
	"actor_user_id" varchar(36) NOT NULL,
	"event_type" varchar(30) NOT NULL,
	"from_status" varchar(30),
	"to_status" varchar(30) NOT NULL,
	"client_request_id" varchar(36) NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_client_request_id_unique" UNIQUE("client_request_id")
);
--> statement-breakpoint
CREATE TABLE "handoff"."states" (
	"conversation_id" varchar(300) PRIMARY KEY NOT NULL,
	"status" varchar(30) NOT NULL,
	"reason" text NOT NULL,
	"assigned_user_id" varchar(36),
	"created_by_user_id" varchar(36) NOT NULL,
	"resolved_by_user_id" varchar(36),
	"resolution" text,
	"agent_paused" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handoff"."events" ADD CONSTRAINT "events_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD CONSTRAINT "states_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handoff_events_conversation_created_idx" ON "handoff"."events" USING btree ("conversation_id","created_at");