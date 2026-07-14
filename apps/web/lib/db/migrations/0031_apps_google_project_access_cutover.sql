INSERT INTO "app_connections" (
  "id", "organization_id", "app_key", "owner_type", "user_id",
  "auth_account_id", "name", "status", "external_account_id",
  "external_account_label", "scopes", "failure_code", "last_health_at",
  "disconnected_at", "created_at", "updated_at"
)
SELECT
  connection."id",
  connection."organization_id",
  connection."provider_key",
  'personal',
  connection."user_id",
  connection."auth_account_id",
  COALESCE(NULLIF(connection."provider_login", ''), 'Personal account'),
  connection."status",
  connection."provider_account_id",
  connection."provider_login",
  connection."scopes",
  connection."failure_code",
  connection."last_synced_at",
  connection."disconnected_at",
  connection."created_at",
  connection."updated_at"
FROM "user_tool_connections" connection
JOIN "app_definitions" app ON app."key" = connection."provider_key"
WHERE connection."provider_key" = 'google_workspace'
ON CONFLICT ("id") DO UPDATE SET
  "organization_id" = excluded."organization_id",
  "app_key" = excluded."app_key",
  "owner_type" = excluded."owner_type",
  "user_id" = excluded."user_id",
  "auth_account_id" = excluded."auth_account_id",
  "name" = excluded."name",
  "status" = excluded."status",
  "external_account_id" = excluded."external_account_id",
  "external_account_label" = excluded."external_account_label",
  "scopes" = excluded."scopes",
  "failure_code" = excluded."failure_code",
  "last_health_at" = excluded."last_health_at",
  "disconnected_at" = excluded."disconnected_at",
  "updated_at" = now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "project_user_tool_capabilities" access
    LEFT JOIN "app_connections" connection
      ON connection."id" = access."connection_id"
    LEFT JOIN "app_capabilities" capability
      ON capability."app_key" = access."provider_key"
      AND capability."key" = access."capability_key"
    WHERE connection."id" IS NULL
      OR connection."app_key" <> access."provider_key"
      OR capability."key" IS NULL
  ) THEN
    RAISE EXCEPTION 'Project personal access is missing from canonical Apps authority';
  END IF;
END $$;

ALTER TABLE "project_user_tool_capabilities"
  DROP CONSTRAINT "project_user_tool_capabilities_connection_id_fkey";
ALTER TABLE "project_user_tool_capabilities"
  DROP CONSTRAINT "project_user_tool_capabilities_capability_fk";

ALTER TABLE "project_user_tool_capabilities"
  RENAME TO "project_app_user_capabilities";
ALTER TABLE "project_app_user_capabilities"
  RENAME COLUMN "provider_key" TO "app_key";

ALTER TABLE "project_app_user_capabilities"
  RENAME CONSTRAINT "project_user_tool_capabilities_pkey"
  TO "project_app_user_capabilities_pkey";
ALTER TABLE "project_app_user_capabilities"
  RENAME CONSTRAINT "project_user_tool_capabilities_project_id_fkey"
  TO "project_app_user_capabilities_project_id_fkey";
ALTER TABLE "project_app_user_capabilities"
  RENAME CONSTRAINT "project_user_tool_capabilities_audience_check"
  TO "project_app_user_capabilities_audience_check";

ALTER INDEX "project_user_tool_capabilities_scope_idx"
  RENAME TO "project_app_user_capabilities_scope_idx";
ALTER INDEX "project_user_tool_capabilities_project_idx"
  RENAME TO "project_app_user_capabilities_project_idx";
ALTER INDEX "project_user_tool_capabilities_connection_idx"
  RENAME TO "project_app_user_capabilities_connection_idx";
ALTER INDEX "project_user_tool_capabilities_subject_idx"
  RENAME TO "project_app_user_capabilities_subject_idx";

ALTER TABLE "project_app_user_capabilities"
  ADD CONSTRAINT "project_app_user_capabilities_connection_fk"
  FOREIGN KEY ("connection_id")
  REFERENCES "app_connections"("id")
  ON DELETE CASCADE
  NOT VALID;
ALTER TABLE "project_app_user_capabilities"
  ADD CONSTRAINT "project_app_user_capabilities_capability_fk"
  FOREIGN KEY ("app_key", "capability_key")
  REFERENCES "app_capabilities"("app_key", "key")
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE "project_app_user_capabilities"
  VALIDATE CONSTRAINT "project_app_user_capabilities_connection_fk";
ALTER TABLE "project_app_user_capabilities"
  VALIDATE CONSTRAINT "project_app_user_capabilities_capability_fk";
