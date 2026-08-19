CREATE TABLE "knowledge"."client_threads" (
  "thread_id" varchar(100) PRIMARY KEY NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "scope_type" varchar(30) NOT NULL,
  "scope_id" varchar(300) NOT NULL,
  "weknora_session_id" varchar(300) NOT NULL,
  "title" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge"."client_thread_messages" (
  "message_id" varchar(100) PRIMARY KEY NOT NULL,
  "thread_id" varchar(100) NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "role" varchar(20) NOT NULL,
  "content" text NOT NULL,
  "references" jsonb NOT NULL,
  "suggestions" jsonb NOT NULL,
  "completed" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge"."client_threads" ADD CONSTRAINT "client_knowledge_threads_user_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge"."client_thread_messages" ADD CONSTRAINT "client_knowledge_thread_messages_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "knowledge"."client_threads"("thread_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge"."client_thread_messages" ADD CONSTRAINT "client_knowledge_thread_messages_user_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "client_knowledge_threads_user_updated_idx" ON "knowledge"."client_threads" USING btree ("user_id", "updated_at");
--> statement-breakpoint
CREATE INDEX "client_knowledge_threads_user_scope_idx" ON "knowledge"."client_threads" USING btree ("user_id", "scope_type", "scope_id");
--> statement-breakpoint
CREATE INDEX "client_knowledge_thread_messages_thread_created_idx" ON "knowledge"."client_thread_messages" USING btree ("thread_id", "created_at");
--> statement-breakpoint
CREATE INDEX "client_knowledge_thread_messages_user_idx" ON "knowledge"."client_thread_messages" USING btree ("user_id");
