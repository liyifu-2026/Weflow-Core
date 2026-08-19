CREATE TABLE "knowledge"."chunks" (
	"chunk_id" varchar(100) PRIMARY KEY NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"source_locator" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_chunks_version_ordinal_unique" UNIQUE("version_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "knowledge"."chunks" ADD CONSTRAINT "chunks_version_id_document_versions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "knowledge"."document_versions"("version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_version_idx" ON "knowledge"."chunks" USING btree ("version_id");