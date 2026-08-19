ALTER TABLE "knowledge"."client_thread_messages" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
