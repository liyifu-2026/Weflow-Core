-- Channel Host media references are opaque to Weflow.
ALTER TABLE "media"."assets"
  ALTER COLUMN "source_local_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "media"."assets"
  ADD COLUMN "source_media_ref" varchar(512);
--> statement-breakpoint
CREATE INDEX "media_assets_source_media_ref_idx"
  ON "media"."assets" USING btree ("source_media_ref");
