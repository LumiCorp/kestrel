ALTER TABLE "thread_interactions"
  ADD COLUMN "runtime_approval_id" text;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD COLUMN "source_runtime_run_id" text;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD COLUMN "response_failure_code" text;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD COLUMN "response_failure_message" text;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD COLUMN "effect_status" text;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD COLUMN "response_retryable" boolean;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD CONSTRAINT "thread_interactions_effect_status_check"
  CHECK ("effect_status" IS NULL OR "effect_status" IN ('not_started', 'started', 'unknown'));
--> statement-breakpoint
UPDATE "thread_interactions"
   SET "runtime_approval_id" = "request_envelope"->'approval'->>'toolCallId'
 WHERE "kind" = 'approval'
   AND "runtime_approval_id" IS NULL
   AND NULLIF("request_envelope"->'approval'->>'toolCallId', '') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "thread_interactions_runtime_approval_idx"
  ON "thread_interactions" ("organization_id", "runtime_approval_id")
  WHERE "runtime_approval_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "thread_interactions_source_runtime_run_idx"
  ON "thread_interactions" ("source_runtime_run_id")
  WHERE "source_runtime_run_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "thread_turns"
  ADD COLUMN "resume_interaction_id" text;
--> statement-breakpoint
ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_resume_interaction_fk"
  FOREIGN KEY ("resume_interaction_id") REFERENCES "thread_interactions"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "thread_turns"
  DROP CONSTRAINT "thread_turns_input_contract_check";
--> statement-breakpoint
ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_input_contract_check" CHECK (
    (
      "resume_interaction_id" IS NULL AND (
        ("input_message_id" IS NOT NULL AND "approval_id" IS NULL AND "approval_approved" IS NULL AND "approval_reason" IS NULL)
        OR
        ("input_message_id" IS NULL AND "approval_id" IS NOT NULL AND "approval_approved" IS NOT NULL)
      )
    )
    OR
    (
      "resume_interaction_id" IS NOT NULL AND "input_message_id" IS NULL
      AND "approval_id" IS NULL AND "approval_approved" IS NULL AND "approval_reason" IS NULL
    )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_turns_active_interaction_retry_idx"
  ON "thread_turns" ("resume_interaction_id")
  WHERE "resume_interaction_id" IS NOT NULL
    AND "status" IN ('queued', 'running', 'waiting_for_input');
--> statement-breakpoint

ALTER TABLE "environment_run_executions"
  ADD COLUMN "failure_code" text;
--> statement-breakpoint
ALTER TABLE "environment_run_executions"
  ADD COLUMN "failure_message" text;
--> statement-breakpoint

INSERT INTO "app_connection_resources" (
  "id", "connection_id", "external_id", "resource_type", "label",
  "enabled", "permissions", "metadata", "created_at", "updated_at"
)
SELECT
  connection."id" || ':primary-calendar', connection."id", 'primary',
  'calendar', 'Primary calendar', true, '{}'::jsonb,
  jsonb_build_object('logical', true), now(), now()
FROM "app_connections" connection
WHERE connection."app_key" = 'google_workspace'
  AND connection."status" <> 'disconnected'
ON CONFLICT ("connection_id", "resource_type", "external_id")
DO UPDATE SET "enabled" = true, "updated_at" = now();
--> statement-breakpoint

INSERT INTO "app_connection_resources" (
  "id", "connection_id", "external_id", "resource_type", "label",
  "enabled", "permissions", "metadata", "created_at", "updated_at"
)
SELECT
  connection."id" || ':account', connection."id", 'primary',
  'account', COALESCE(NULLIF(connection."external_account_label", ''), 'Microsoft 365 account'),
  true, '{}'::jsonb, jsonb_build_object('logical', true), now(), now()
FROM "app_connections" connection
WHERE connection."app_key" = 'microsoft_365'
  AND connection."status" <> 'disconnected'
ON CONFLICT ("connection_id", "resource_type", "external_id")
DO UPDATE SET "enabled" = true, "label" = excluded."label", "updated_at" = now();
--> statement-breakpoint

UPDATE "github_action_approvals"
   SET "status" = 'expired', "updated_at" = now()
 WHERE "status" IN ('pending', 'approved');
