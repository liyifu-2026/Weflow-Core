ALTER TABLE "memory"."memories" ADD COLUMN IF NOT EXISTS "importance" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory"."memories" ADD COLUMN IF NOT EXISTS "last_recalled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_contact_status_importance_idx" ON "memory"."memories" USING btree ("contact_id","status","importance","updated_at");
