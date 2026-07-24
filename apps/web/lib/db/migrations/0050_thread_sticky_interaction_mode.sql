ALTER TABLE "threads"
  ADD COLUMN "interaction_mode" text DEFAULT 'chat' NOT NULL;

UPDATE "threads" AS thread
SET "interaction_mode" = latest_turn."requested_interaction_mode"
FROM (
  SELECT DISTINCT ON ("thread_id")
    "thread_id",
    "requested_interaction_mode"
  FROM "thread_turns"
  ORDER BY "thread_id", "sequence" DESC, "created_at" DESC, "id" DESC
) AS latest_turn
WHERE latest_turn."thread_id" = thread."id";

ALTER TABLE "threads"
  ADD CONSTRAINT "threads_interaction_mode_check"
  CHECK ("interaction_mode" IN ('chat', 'plan', 'build'));
