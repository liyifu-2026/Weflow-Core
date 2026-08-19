CREATE TABLE "conversation"."read_states" (
	"user_id" varchar(36) NOT NULL,
	"conversation_id" varchar(300) NOT NULL,
	"last_read_message_id" varchar(600) NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_read_states_user_conversation_unique" UNIQUE("user_id", "conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation"."read_states" ADD CONSTRAINT "read_states_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation"."read_states" ADD CONSTRAINT "read_states_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation"."read_states" ADD CONSTRAINT "read_states_last_read_message_id_messages_message_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "conversation"."messages"("message_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversation_read_states_user_idx" ON "conversation"."read_states" USING btree ("user_id");
