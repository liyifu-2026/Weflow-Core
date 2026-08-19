ALTER TABLE "identity"."users"
ADD COLUMN "role" varchar(20) DEFAULT 'operator' NOT NULL;
--> statement-breakpoint
ALTER TABLE "identity"."users"
ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('admin', 'operator'));
