CREATE SCHEMA "weflow_system";
--> statement-breakpoint
CREATE TABLE "weflow_system"."runtime_metadata" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
