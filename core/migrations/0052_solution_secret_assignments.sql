-- Secret configuration references for installed Solutions. Only references are
-- stored; plaintext secret values must never be written to this table.
CREATE TABLE "solution"."secret_assignments" (
  "solution_id" varchar(200) NOT NULL,
  "slot_name" varchar(200) NOT NULL,
  "ref_type" varchar(20) NOT NULL,
  "ref_value" varchar(1000) NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("solution_id", "slot_name")
);
--> statement-breakpoint
ALTER TABLE "solution"."secret_assignments" ADD CONSTRAINT "secret_assignments_solution_id_installations_solution_id_fk" FOREIGN KEY ("solution_id") REFERENCES "solution"."installations"("solution_id") ON DELETE CASCADE;
