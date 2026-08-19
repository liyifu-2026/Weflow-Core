CREATE SCHEMA IF NOT EXISTS "notification";
--> statement-breakpoint
CREATE TABLE "notification"."devices" ("device_id" varchar(36) PRIMARY KEY NOT NULL,"user_id" varchar(36) NOT NULL,"push_token" varchar(300) NOT NULL UNIQUE,"platform" varchar(20) NOT NULL,"show_preview" boolean DEFAULT false NOT NULL,"revoked_at" timestamp with time zone,"updated_at" timestamp with time zone DEFAULT now() NOT NULL);
--> statement-breakpoint
CREATE TABLE "notification"."outbox" ("notification_id" varchar(100) PRIMARY KEY NOT NULL,"user_id" varchar(36) NOT NULL,"conversation_id" varchar(300) NOT NULL,"kind" varchar(50) NOT NULL,"dedupe_key" varchar(300) NOT NULL UNIQUE,"payload" jsonb NOT NULL,"status" varchar(20) DEFAULT 'pending' NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"sent_at" timestamp with time zone);
--> statement-breakpoint
ALTER TABLE "notification"."devices" ADD CONSTRAINT "devices_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id");
--> statement-breakpoint
ALTER TABLE "notification"."outbox" ADD CONSTRAINT "outbox_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id");
--> statement-breakpoint
ALTER TABLE "notification"."outbox" ADD CONSTRAINT "outbox_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id");
--> statement-breakpoint
CREATE INDEX "notification_devices_user_idx" ON "notification"."devices" ("user_id");
--> statement-breakpoint
CREATE INDEX "notification_outbox_status_idx" ON "notification"."outbox" ("status","created_at");
