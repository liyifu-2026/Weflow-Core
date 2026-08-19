ALTER TABLE "collaboration"."requests" ADD COLUMN "claim_summary" text;
--> statement-breakpoint
UPDATE "collaboration"."requests"
SET "claim_summary" = left(regexp_replace("reason", '[0-9+() -]{7,}', '[已隐藏联系方式]', 'g'), 160)
WHERE "claim_summary" IS NULL;
--> statement-breakpoint
ALTER TABLE "collaboration"."requests" ALTER COLUMN "claim_summary" SET NOT NULL;
