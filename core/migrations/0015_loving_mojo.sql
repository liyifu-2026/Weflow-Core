CREATE TABLE "agent"."tool_executions" (
	"execution_id" varchar(700) PRIMARY KEY NOT NULL,
	"turn_id" varchar(700) NOT NULL,
	"conversation_id" varchar(300) NOT NULL,
	"tool_name" varchar(80) NOT NULL,
	"status" varchar(30) NOT NULL,
	"idempotency_key" varchar(700) NOT NULL,
	"arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tool_executions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "agent"."tool_executions" ADD CONSTRAINT "tool_executions_turn_id_turns_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "agent"."turns"("turn_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent"."tool_executions" ADD CONSTRAINT "tool_executions_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_executions_turn_idx" ON "agent"."tool_executions" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "tool_executions_status_idx" ON "agent"."tool_executions" USING btree ("status","created_at");