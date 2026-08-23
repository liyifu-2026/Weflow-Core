ALTER TABLE "media"."assets" ADD COLUMN "source_variant" varchar(16);
ALTER TABLE "media"."assets" ADD COLUMN "upgrade_attempt" integer DEFAULT 0 NOT NULL;
