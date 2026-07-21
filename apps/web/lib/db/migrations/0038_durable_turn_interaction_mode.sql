ALTER TABLE "thread_turns"
  ADD COLUMN "requested_interaction_mode" text DEFAULT 'chat' NOT NULL;

ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_requested_interaction_mode_check"
  CHECK ("requested_interaction_mode" IN ('chat', 'plan', 'build'));
