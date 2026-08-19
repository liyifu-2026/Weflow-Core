CREATE SCHEMA "file_storage";
--> statement-breakpoint
CREATE SCHEMA "knowledge";
--> statement-breakpoint
CREATE TABLE "knowledge"."collections" (
	"collection_id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge"."document_versions" (
	"version_id" varchar(36) PRIMARY KEY NOT NULL,
	"document_id" varchar(36) NOT NULL,
	"version_number" integer NOT NULL,
	"source_file_id" varchar(36) NOT NULL,
	"ingestion_state" varchar(30) NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_document_number_unique" UNIQUE("document_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."documents" (
	"document_id" varchar(36) PRIMARY KEY NOT NULL,
	"collection_id" varchar(36) NOT NULL,
	"title" varchar(300) NOT NULL,
	"current_version_id" varchar(36),
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge"."ingestion_runs" (
	"run_id" varchar(36) PRIMARY KEY NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"status" varchar(30) NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(100),
	"trace_id" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_storage"."files" (
	"file_id" varchar(36) PRIMARY KEY NOT NULL,
	"owner_module" varchar(50) NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" varchar(200) NOT NULL,
	"size" bigint NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"storage_key" varchar(200) NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "knowledge"."document_versions" ADD CONSTRAINT "document_versions_document_id_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "knowledge"."documents"("document_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."document_versions" ADD CONSTRAINT "document_versions_source_file_id_files_file_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "file_storage"."files"("file_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."documents" ADD CONSTRAINT "documents_collection_id_collections_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "knowledge"."collections"("collection_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."ingestion_runs" ADD CONSTRAINT "ingestion_runs_version_id_document_versions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "knowledge"."document_versions"("version_id") ON DELETE no action ON UPDATE no action;