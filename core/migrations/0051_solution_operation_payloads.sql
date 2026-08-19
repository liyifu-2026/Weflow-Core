-- Runner payload and lease ownership for Solution Operations.
ALTER TABLE "solution"."operations" ADD COLUMN "runner_id" varchar(200);
--> statement-breakpoint
CREATE TABLE "solution"."operation_payloads" (
  "operation_id" varchar(100) PRIMARY KEY,
  "manifest_json" jsonb NOT NULL,
  "lock_json" jsonb NOT NULL,
  "signature_json" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "solution"."operation_payloads" ADD CONSTRAINT "operation_payloads_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "solution"."operations"("operation_id") ON DELETE CASCADE;
