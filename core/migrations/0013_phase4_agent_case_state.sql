CREATE TABLE "conversation"."case_states" (
	"conversation_id" varchar(300) PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"intent" varchar(50) DEFAULT 'other' NOT NULL,
	"stage" varchar(50) DEFAULT 'greeting' NOT NULL,
	"known_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_human" boolean DEFAULT false NOT NULL,
	"risk_level" varchar(20) DEFAULT 'low' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation"."case_states" ADD CONSTRAINT "case_states_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE no action ON UPDATE no action;