ALTER TABLE "notification"."outbox" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification"."outbox" ADD COLUMN "error_code" varchar(100);
