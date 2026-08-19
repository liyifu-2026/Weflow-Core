CREATE SCHEMA "knowledge";
--> statement-breakpoint
CREATE TABLE "knowledge"."client_retrievals" (
  "retrieval_id" varchar(100) PRIMARY KEY NOT NULL,
  "conversation_id" varchar(300) NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "query" text NOT NULL,
  "conversation_revision" integer NOT NULL,
  "evidence" jsonb NOT NULL,
  "status" varchar(30) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge"."client_drafts" (
  "draft_id" varchar(100) PRIMARY KEY NOT NULL,
  "retrieval_id" varchar(100) NOT NULL,
  "conversation_id" varchar(300) NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "evidence_ids" jsonb NOT NULL,
  "conversation_revision" integer NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge"."client_retrievals" ADD CONSTRAINT "client_retrievals_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge"."client_retrievals" ADD CONSTRAINT "client_retrievals_user_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge"."client_drafts" ADD CONSTRAINT "client_drafts_retrieval_fk" FOREIGN KEY ("retrieval_id") REFERENCES "knowledge"."client_retrievals"("retrieval_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge"."client_drafts" ADD CONSTRAINT "client_drafts_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge"."client_drafts" ADD CONSTRAINT "client_drafts_user_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "client_knowledge_retrievals_conversation_idx" ON "knowledge"."client_retrievals" USING btree ("conversation_id", "created_at");
--> statement-breakpoint
CREATE INDEX "client_knowledge_drafts_conversation_idx" ON "knowledge"."client_drafts" USING btree ("conversation_id", "created_at");
