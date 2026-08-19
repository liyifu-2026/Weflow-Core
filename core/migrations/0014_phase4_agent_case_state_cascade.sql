ALTER TABLE "conversation"."case_states" DROP CONSTRAINT "case_states_conversation_id_conversations_conversation_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation"."case_states" ADD CONSTRAINT "case_states_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;