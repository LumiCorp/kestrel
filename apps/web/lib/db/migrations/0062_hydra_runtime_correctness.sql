ALTER TABLE "runtime_bindings"
  ADD COLUMN IF NOT EXISTS "native_session_state" text NOT NULL DEFAULT 'ready';

ALTER TABLE "runtime_bindings"
  ADD CONSTRAINT "runtime_bindings_native_session_state_check"
  CHECK ("native_session_state" IN ('uninitialized', 'ready', 'degraded', 'released'));

UPDATE "runtime_bindings"
SET "native_session_state" = 'uninitialized'
WHERE "runtime_id" IN ('codex', 'claude')
  AND "native_session_state" = 'ready';

ALTER TABLE "runtime_interaction_deliveries"
  ADD COLUMN IF NOT EXISTS "acknowledgement_event_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_interaction_deliveries_ack_event_idx"
  ON "runtime_interaction_deliveries" ("acknowledgement_event_id")
  WHERE "acknowledgement_event_id" IS NOT NULL;
