CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE TABLE "audit"."events" (
	"audit_id" varchar(36) PRIMARY KEY NOT NULL,
	"actor_user_id" varchar(36),
	"event_type" varchar(100) NOT NULL,
	"subject_type" varchar(50) NOT NULL,
	"subject_id" varchar(100),
	"source_ip" varchar(100),
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."user_sessions" (
	"session_id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_token_digest_unique" UNIQUE("token_digest")
);
--> statement-breakpoint
CREATE TABLE "identity"."users" (
	"user_id" varchar(36) PRIMARY KEY NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "identity"."user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_sessions_user_expiry_idx" ON "identity"."user_sessions" USING btree ("user_id","expires_at");
