ALTER TABLE "conversation"."case_states" ADD COLUMN "action_history" jsonb DEFAULT '[]'::jsonb NOT NULL;
