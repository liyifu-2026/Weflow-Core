CREATE TABLE "knowledge"."client_evidence_trays" (
  "tray_id" varchar(100) PRIMARY KEY NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "conversation_id" varchar(300) NOT NULL,
  "evidence" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge"."client_evidence_trays" ADD CONSTRAINT "client_knowledge_evidence_tray_user_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge"."client_evidence_trays" ADD CONSTRAINT "client_knowledge_evidence_tray_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "client_knowledge_evidence_tray_user_conversation_unique" ON "knowledge"."client_evidence_trays" USING btree ("user_id", "conversation_id");
--> statement-breakpoint
CREATE TABLE "knowledge"."client_feedback" (
  "feedback_id" varchar(100) PRIMARY KEY NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "conversation_id" varchar(300),
  "thread_id" varchar(100),
  "query" text NOT NULL,
  "answer" text NOT NULL,
  "reference_ids" jsonb NOT NULL,
  "feedback_type" varchar(30) NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge"."client_feedback" ADD CONSTRAINT "client_knowledge_feedback_user_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge"."client_feedback" ADD CONSTRAINT "client_knowledge_feedback_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "client_knowledge_feedback_user_created_idx" ON "knowledge"."client_feedback" USING btree ("user_id", "created_at");
