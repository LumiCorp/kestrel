ALTER TABLE "thread_interactions"
  ADD COLUMN IF NOT EXISTS "answered_at" timestamp with time zone;

UPDATE "thread_interactions"
SET "answered_at" = "resolved_at"
WHERE "answered_at" IS NULL
  AND "response_envelope" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "thread_interactions_processing_delivery_idx"
  ON "thread_interactions" ("turn_id", "answered_at")
  WHERE "source" = 'runtime'
    AND "status" = 'processing'
    AND "resumed_at" IS NULL;
