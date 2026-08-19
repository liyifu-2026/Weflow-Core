CREATE TABLE "conversation"."conversation_visibility" (
  "user_id" varchar(36) NOT NULL,
  "conversation_id" varchar(300) NOT NULL,
  "hidden_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_visibility_user_conversation_unique" UNIQUE("user_id", "conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation"."conversation_visibility" ADD CONSTRAINT "conversation_visibility_user_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation"."conversation_visibility" ADD CONSTRAINT "conversation_visibility_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversation_visibility_user_hidden_idx" ON "conversation"."conversation_visibility" USING btree ("user_id", "hidden_at");
