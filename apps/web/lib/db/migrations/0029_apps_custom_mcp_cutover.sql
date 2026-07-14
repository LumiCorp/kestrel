DELETE FROM "app_capabilities" capability
USING "app_definitions" app
WHERE app."key" = capability."app_key"
  AND app."kind" = 'custom'
  AND app."delivery" = 'mcp';

INSERT INTO "app_capabilities" (
  "app_key", "key", "runtime_name", "display_name", "description",
  "group_key", "access_mode", "audience", "default_enabled",
  "default_approval_mode", "default_rate_limit_mode", "default_logging_mode",
  "default_settings", "metadata", "created_at", "updated_at"
)
SELECT
  capability."provider_key",
  capability."kind" || ':' || capability."capability_key",
  'mcp.capability.' || capability."id",
  COALESCE(capability."display_name", capability."capability_key"),
  COALESCE(capability."description", 'Capability provided by a Custom App.'),
  capability."kind",
  CASE
    WHEN capability."kind" IN ('tool', 'sampling', 'elicitation') THEN 'write'
    WHEN capability."kind" IN ('task', 'logging') THEN 'status'
    WHEN capability."kind" = 'root' THEN 'internal'
    ELSE 'read'
  END,
  'project',
  false,
  'deny',
  'default',
  'full',
  '{}'::jsonb,
  jsonb_build_object(
    'mcpCapabilityId', capability."id",
    'mcpKind', capability."kind"
  ),
  capability."created_at",
  now()
FROM "mcp_capabilities" capability
JOIN "mcp_capability_snapshots" snapshot
  ON snapshot."id" = capability."snapshot_id"
  AND snapshot."status" = 'approved'
JOIN "mcp_servers" server ON server."id" = snapshot."server_id"
JOIN "app_definitions" app
  ON app."key" = capability."provider_key"
  AND app."kind" = 'custom'
  AND app."delivery" = 'mcp'
ON CONFLICT ("app_key", "key") DO UPDATE SET
  "runtime_name" = excluded."runtime_name",
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "group_key" = excluded."group_key",
  "access_mode" = excluded."access_mode",
  "metadata" = excluded."metadata",
  "updated_at" = now();

INSERT INTO "environment_app_capability_grants" (
  "environment_id", "app_key", "capability_key", "enabled",
  "approval_mode", "logging_mode", "rate_limit_mode", "settings",
  "created_at", "updated_at"
)
SELECT
  server."environment_id",
  capability."provider_key",
  capability."kind" || ':' || capability."capability_key",
  capability."environment_enabled",
  CASE
    WHEN capability."environment_enabled" THEN capability."approval_mode"
    ELSE 'deny'
  END,
  'full',
  'default',
  '{}'::jsonb,
  capability."created_at",
  now()
FROM "mcp_capabilities" capability
JOIN "mcp_capability_snapshots" snapshot
  ON snapshot."id" = capability."snapshot_id"
  AND snapshot."status" = 'approved'
JOIN "mcp_servers" server ON server."id" = snapshot."server_id"
JOIN "app_capabilities" app_capability
  ON app_capability."app_key" = capability."provider_key"
  AND app_capability."key" = capability."kind" || ':' || capability."capability_key"
ON CONFLICT ("environment_id", "app_key", "capability_key") DO UPDATE SET
  "enabled" = excluded."enabled",
  "approval_mode" = excluded."approval_mode",
  "logging_mode" = excluded."logging_mode",
  "rate_limit_mode" = excluded."rate_limit_mode",
  "settings" = excluded."settings",
  "updated_at" = now();

INSERT INTO "project_apps" (
  "project_id", "app_key", "enabled", "settings", "created_at", "updated_at"
)
SELECT DISTINCT
  restriction."project_id",
  server."provider_key",
  true,
  '{}'::jsonb,
  restriction."created_at",
  now()
FROM "mcp_project_capability_restrictions" restriction
JOIN "mcp_capabilities" capability ON capability."id" = restriction."capability_id"
JOIN "mcp_capability_snapshots" snapshot
  ON snapshot."id" = capability."snapshot_id"
  AND snapshot."status" = 'approved'
JOIN "mcp_servers" server ON server."id" = snapshot."server_id"
ON CONFLICT ("project_id", "app_key") DO UPDATE SET
  "enabled" = true,
  "updated_at" = now();

INSERT INTO "project_app_connections" (
  "project_id", "app_key", "connection_id", "scope", "user_id",
  "is_default", "added_by_user_id", "created_at", "updated_at"
)
SELECT DISTINCT
  restriction."project_id",
  server."provider_key",
  server."id",
  'shared',
  NULL,
  true,
  server."created_by_user_id",
  restriction."created_at",
  now()
FROM "mcp_project_capability_restrictions" restriction
JOIN "mcp_capabilities" capability ON capability."id" = restriction."capability_id"
JOIN "mcp_capability_snapshots" snapshot
  ON snapshot."id" = capability."snapshot_id"
  AND snapshot."status" = 'approved'
JOIN "mcp_servers" server ON server."id" = snapshot."server_id"
JOIN "project_environment_bindings" binding
  ON binding."project_id" = restriction."project_id"
  AND binding."environment_id" = server."environment_id"
JOIN "app_connections" connection ON connection."id" = server."id"
ON CONFLICT ("project_id", "app_key", "connection_id") DO UPDATE SET
  "scope" = 'shared',
  "user_id" = NULL,
  "is_default" = true,
  "updated_at" = now();

INSERT INTO "project_app_capability_policies" (
  "project_id", "app_key", "capability_key", "enabled", "approval_mode",
  "logging_mode", "rate_limit_mode", "settings", "created_at", "updated_at"
)
SELECT
  restriction."project_id",
  capability."provider_key",
  capability."kind" || ':' || capability."capability_key",
  restriction."enabled",
  CASE WHEN restriction."enabled" THEN restriction."approval_mode" ELSE 'deny' END,
  'full',
  'default',
  '{}'::jsonb,
  restriction."created_at",
  now()
FROM "mcp_project_capability_restrictions" restriction
JOIN "mcp_capabilities" capability ON capability."id" = restriction."capability_id"
JOIN "mcp_capability_snapshots" snapshot
  ON snapshot."id" = capability."snapshot_id"
  AND snapshot."status" = 'approved'
JOIN "app_capabilities" app_capability
  ON app_capability."app_key" = capability."provider_key"
  AND app_capability."key" = capability."kind" || ':' || capability."capability_key"
ON CONFLICT ("project_id", "app_key", "capability_key") DO UPDATE SET
  "enabled" = excluded."enabled",
  "approval_mode" = excluded."approval_mode",
  "logging_mode" = excluded."logging_mode",
  "rate_limit_mode" = excluded."rate_limit_mode",
  "settings" = excluded."settings",
  "updated_at" = now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "project_app_capability_policies" policy
    JOIN "app_definitions" app ON app."key" = policy."app_key"
    JOIN "project_environment_bindings" binding ON binding."project_id" = policy."project_id"
    LEFT JOIN "environment_app_capability_grants" environment_grant
      ON environment_grant."environment_id" = binding."environment_id"
      AND environment_grant."app_key" = policy."app_key"
      AND environment_grant."capability_key" = policy."capability_key"
    WHERE app."kind" = 'custom'
      AND app."delivery" = 'mcp'
      AND policy."enabled" = true
      AND (
        environment_grant."capability_key" IS NULL
        OR environment_grant."enabled" = false
        OR environment_grant."approval_mode" = 'deny'
        OR (environment_grant."approval_mode" = 'ask' AND policy."approval_mode" = 'auto')
      )
  ) THEN
    RAISE EXCEPTION 'Custom App cutover would widen Project access beyond its Environment';
  END IF;
END $$;
