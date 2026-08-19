ALTER TABLE "infrastructure_connector_enrollment_requests"
  ALTER COLUMN "organization_id" DROP NOT NULL,
  ALTER COLUMN "provider_connection_id" DROP NOT NULL,
  ADD COLUMN "connector_name" text,
  ADD COLUMN "connector_version" text,
  ADD COLUMN "supported_command_versions" jsonb,
  ADD COLUMN "supported_result_versions" jsonb,
  ADD COLUMN "cluster_metadata" jsonb,
  ADD COLUMN "consumption_envelope" jsonb;

UPDATE "infrastructure_connector_enrollment_requests"
SET "connector_name" = 'Legacy connector',
    "connector_version" = 'unknown',
    "supported_command_versions" = '["infrastructure-connector-command-v1"]'::jsonb,
    "supported_result_versions" = '["infrastructure-connector-result-v1"]'::jsonb,
    "cluster_metadata" = '{}'::jsonb
WHERE "connector_name" IS NULL;

ALTER TABLE "infrastructure_connector_enrollment_requests"
  ALTER COLUMN "connector_name" SET NOT NULL,
  ALTER COLUMN "connector_version" SET NOT NULL,
  ALTER COLUMN "supported_command_versions" SET NOT NULL,
  ALTER COLUMN "supported_result_versions" SET NOT NULL,
  ALTER COLUMN "cluster_metadata" SET NOT NULL;

DROP INDEX "infrastructure_connector_enrollment_fingerprint_idx";
CREATE UNIQUE INDEX "infrastructure_connector_enrollment_fingerprint_idx"
  ON "infrastructure_connector_enrollment_requests" ("fingerprint");

CREATE TABLE "infrastructure_connector_qualification_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "provider_connection_id" text NOT NULL,
  "requested_by_user_id" text,
  "config_revision" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "command_id" text,
  "result" jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "infrastructure_connector_qualification_runs_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_qualification_runs_provider_connection_id_fk"
    FOREIGN KEY ("provider_connection_id") REFERENCES "environment_provider_connections"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_qualification_runs_requested_by_user_id_fk"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE set null,
  CONSTRAINT "infrastructure_connector_qualification_runs_status_check"
    CHECK ("status" IN ('queued', 'running', 'passed', 'failed', 'cancelled'))
);

CREATE UNIQUE INDEX "infrastructure_connector_qualification_command_idx"
  ON "infrastructure_connector_qualification_runs" ("command_id")
  WHERE "command_id" IS NOT NULL;
CREATE INDEX "infrastructure_connector_qualification_connection_idx"
  ON "infrastructure_connector_qualification_runs" ("organization_id", "provider_connection_id", "created_at");

ALTER TABLE "infrastructure_connector_commands"
  ALTER COLUMN "operation_id" DROP NOT NULL,
  ADD COLUMN "qualification_run_id" text,
  ADD CONSTRAINT "infrastructure_connector_commands_qualification_run_id_fk"
    FOREIGN KEY ("qualification_run_id") REFERENCES "infrastructure_connector_qualification_runs"("id") ON DELETE cascade,
  ADD CONSTRAINT "infrastructure_connector_commands_owner_check"
    CHECK (num_nonnulls("operation_id", "qualification_run_id") = 1);

DROP INDEX "infrastructure_connector_commands_operation_idx";
CREATE UNIQUE INDEX "infrastructure_connector_commands_operation_idx"
  ON "infrastructure_connector_commands" ("operation_id")
  WHERE "operation_id" IS NOT NULL;
CREATE UNIQUE INDEX "infrastructure_connector_commands_qualification_idx"
  ON "infrastructure_connector_commands" ("qualification_run_id")
  WHERE "qualification_run_id" IS NOT NULL;

ALTER TABLE "infrastructure_connector_qualification_runs"
  ADD CONSTRAINT "infrastructure_connector_qualification_runs_command_id_fk"
    FOREIGN KEY ("command_id") REFERENCES "infrastructure_connector_commands"("id") ON DELETE set null;
