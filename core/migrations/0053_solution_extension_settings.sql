-- Generic settings storage for Solution-provided Console extensions.
-- Settings are plain JSON and are managed by the Weflow platform uniformly.
CREATE TABLE "solution"."extension_settings" (
  "solution_id" varchar(200) NOT NULL,
  "extension_id" varchar(200) NOT NULL,
  "settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_by" varchar(200),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("solution_id", "extension_id")
);
--> statement-breakpoint
ALTER TABLE "solution"."extension_settings" ADD CONSTRAINT "extension_settings_solution_id_installations_solution_id_fk" FOREIGN KEY ("solution_id") REFERENCES "solution"."installations"("solution_id") ON DELETE CASCADE;
