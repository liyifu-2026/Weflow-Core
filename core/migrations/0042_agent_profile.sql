ALTER TABLE "identity"."users" ADD COLUMN "display_name" varchar(24);
--> statement-breakpoint
ALTER TABLE "identity"."users" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "identity"."users" ADD CONSTRAINT "users_tags_is_array_check" CHECK (jsonb_typeof("tags") = 'array');
