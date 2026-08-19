ALTER TABLE "media"."assets" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "media"."assets" ADD COLUMN "description_model" varchar(100);--> statement-breakpoint
ALTER TABLE "media"."assets" ADD COLUMN "processed_at" timestamp with time zone;