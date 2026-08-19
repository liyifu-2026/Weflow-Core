ALTER TABLE "conversation"."case_states" ADD COLUMN "asked_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;
