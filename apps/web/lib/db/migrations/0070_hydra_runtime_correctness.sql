ALTER TABLE "runtime_bindings"
  ADD COLUMN IF NOT EXISTS "native_session_state" text NOT NULL DEFAULT 'ready';

ALTER TABLE "runtime_bindings"
  ADD COLUMN IF NOT EXISTS "environment_id" text,
  ADD COLUMN IF NOT EXISTS "selected_model_id" text,
  ADD COLUMN IF NOT EXISTS "recovery_source_binding_id" text,
  ADD COLUMN IF NOT EXISTS "recovery_failure_code" text,
  ADD COLUMN IF NOT EXISTS "recovery_source_turn_id" text;

ALTER TABLE "runtime_bindings"
  ADD CONSTRAINT "runtime_bindings_environment_id_fk"
  FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE RESTRICT;

ALTER TABLE "runtime_bindings"
  ADD CONSTRAINT "runtime_bindings_native_session_state_check"
  CHECK ("native_session_state" IN ('uninitialized', 'ready', 'degraded', 'released'));

ALTER TABLE "runtime_bindings"
  ADD CONSTRAINT "runtime_bindings_recovery_failure_code_check"
  CHECK (
    (
      "recovery_source_binding_id" IS NULL AND
      "recovery_failure_code" IS NULL AND
      "recovery_source_turn_id" IS NULL
    ) OR
    (
      "recovery_source_binding_id" IS NOT NULL AND
      "recovery_source_turn_id" IS NOT NULL AND
      "recovery_failure_code" IN ('RUNTIME_NATIVE_SESSION_LOST', 'RUNTIME_LIVE_WAIT_LOST')
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_bindings_recovery_source_loss_idx"
  ON "runtime_bindings" ("recovery_source_binding_id", "recovery_failure_code")
  WHERE "recovery_source_binding_id" IS NOT NULL;

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
  ADD COLUMN IF NOT EXISTS "runtime_run_id" text,
  ADD COLUMN IF NOT EXISTS "dispatch_execution_bound_at" timestamp with time zone;

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
  "claim_token_hash" text,
  "claim_expires_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "acknowledgement_event_id" text,
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
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_binding_release_outbox_ack_event_idx"
  ON "runtime_binding_release_outbox" ("acknowledgement_event_id")
  WHERE "acknowledgement_event_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "runtime_binding_release_outbox_claim_idx"
  ON "runtime_binding_release_outbox" ("environment_id", "state", "created_at");

ALTER TABLE "environment_run_executions"
  ADD COLUMN IF NOT EXISTS "runtime_event_reconciliation_state" text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS "runtime_event_reconciliation_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "runtime_event_reconciliation_code" text,
  ADD COLUMN IF NOT EXISTS "runtime_event_reconciliation_attempted_at" timestamp with time zone;

ALTER TABLE "environment_run_executions"
  ADD CONSTRAINT "environment_run_executions_runtime_event_reconciliation_state_check"
  CHECK ("runtime_event_reconciliation_state" IN ('idle', 'pending'));

CREATE TABLE IF NOT EXISTS "desktop_runtime_descriptor_probes" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "environment_id" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "runtime_id" text NOT NULL,
  "requested_model_id" text NOT NULL,
  "request" jsonb NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "claim_token_hash" text,
  "claim_expires_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "acknowledgement_event_id" text,
  "resolution" jsonb,
  "failure_code" text,
  "failure_message" text,
  "expires_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_runtime_descriptor_probes_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "desktop_runtime_descriptor_probes_environment_id_fk"
    FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE,
  CONSTRAINT "desktop_runtime_descriptor_probes_actor_user_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE CASCADE,
  CONSTRAINT "desktop_runtime_descriptor_probes_runtime_id_check"
    CHECK ("runtime_id" IN ('codex', 'claude')),
  CONSTRAINT "desktop_runtime_descriptor_probes_state_check"
    CHECK ("state" IN ('pending', 'delivering', 'resolved', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS "desktop_runtime_descriptor_probes_claim_idx"
  ON "desktop_runtime_descriptor_probes" ("environment_id", "state", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "desktop_runtime_descriptor_probes_ack_event_idx"
  ON "desktop_runtime_descriptor_probes" ("acknowledgement_event_id")
  WHERE "acknowledgement_event_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "desktop_runtime_descriptor_probes_expiry_idx"
  ON "desktop_runtime_descriptor_probes" ("state", "expires_at");
