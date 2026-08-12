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

ALTER TABLE "thread_interactions"
  ADD COLUMN IF NOT EXISTS "private_runtime_metadata" jsonb;

ALTER TABLE "runtime_interaction_deliveries"
  ADD COLUMN IF NOT EXISTS "environment_execution_id" text,
  ADD COLUMN IF NOT EXISTS "runtime_run_id" text;

ALTER TABLE "runtime_interaction_deliveries"
  ADD CONSTRAINT "runtime_interaction_deliveries_environment_execution_id_fk"
  FOREIGN KEY ("environment_execution_id")
  REFERENCES "environment_run_executions"("id")
  ON DELETE CASCADE;

ALTER TABLE "runtime_interaction_deliveries"
  ALTER COLUMN "environment_execution_id" SET NOT NULL,
  ALTER COLUMN "runtime_run_id" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_interaction_deliveries_ack_event_idx"
  ON "runtime_interaction_deliveries" ("acknowledgement_event_id")
  WHERE "acknowledgement_event_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "runtime_binding_release_outbox" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "runtime_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "participant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "acknowledged_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runtime_binding_release_outbox_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "runtime_binding_release_outbox_runtime_id_check"
    CHECK ("runtime_id" IN ('codex', 'claude')),
  CONSTRAINT "runtime_binding_release_outbox_state_check"
    CHECK ("state" IN ('pending', 'delivering', 'released', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_binding_release_outbox_idempotency_idx"
  ON "runtime_binding_release_outbox" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "runtime_binding_release_outbox_state_idx"
  ON "runtime_binding_release_outbox" ("state", "created_at");
