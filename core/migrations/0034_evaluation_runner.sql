ALTER TABLE "evaluation"."runs"
ADD COLUMN "started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "evaluation"."runs"
ADD COLUMN "error_code" varchar(100);
