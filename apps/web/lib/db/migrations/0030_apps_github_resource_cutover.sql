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
WHERE connection."provider_key" = 'github'
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

INSERT INTO "app_connection_resources" (
  "id", "connection_id", "external_id", "resource_type", "label",
  "enabled", "permissions", "metadata", "created_at", "updated_at"
)
SELECT
  resource."id",
  connection."id",
  resource."external_id",
  resource."resource_type",
  resource."label",
  resource."enabled",
  jsonb_build_object(
    'pull', mapping."can_pull",
    'push', mapping."can_push",
    'admin', mapping."can_admin"
  ),
  COALESCE(resource."metadata", '{}'::jsonb),
  resource."created_at",
  resource."updated_at"
FROM "user_tool_connection_resources" mapping
JOIN "user_tool_connections" legacy_connection
  ON legacy_connection."id" = mapping."connection_id"
  AND legacy_connection."provider_key" = 'github'
JOIN "app_connections" connection ON connection."id" = legacy_connection."id"
JOIN "tool_connection_resources" resource ON resource."id" = mapping."resource_id"
ON CONFLICT ("id") DO UPDATE SET
  "connection_id" = excluded."connection_id",
  "external_id" = excluded."external_id",
  "resource_type" = excluded."resource_type",
  "label" = excluded."label",
  "enabled" = excluded."enabled",
  "permissions" = excluded."permissions",
  "metadata" = excluded."metadata",
  "updated_at" = now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "environment_workspaces" workspace
    LEFT JOIN "app_connection_resources" resource
      ON resource."id" = workspace."source_resource_id"
    LEFT JOIN "app_connections" connection
      ON connection."id" = resource."connection_id"
    WHERE workspace."source_type" = 'github'
      AND (
        resource."id" IS NULL
        OR resource."resource_type" <> 'repository'
        OR connection."app_key" <> 'github'
        OR connection."organization_id" <> workspace."organization_id"
      )
  ) THEN
    RAISE EXCEPTION 'GitHub Workspace source is missing from canonical App resources';
  END IF;
END $$;

ALTER TABLE "environment_workspaces"
  DROP CONSTRAINT "environment_workspaces_source_resource_fk";

ALTER TABLE "environment_workspaces"
  ADD CONSTRAINT "environment_workspaces_source_resource_fk"
  FOREIGN KEY ("source_resource_id")
  REFERENCES "app_connection_resources"("id")
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE "environment_workspaces"
  VALIDATE CONSTRAINT "environment_workspaces_source_resource_fk";
