ALTER TABLE "app_definitions"
  DROP CONSTRAINT "app_definitions_category_check";
--> statement-breakpoint
ALTER TABLE "app_definitions"
  ADD CONSTRAINT "app_definitions_category_check" CHECK (
    "category" IN (
      'kestrel', 'search_research', 'productivity', 'engineering',
      'knowledge_sources', 'communication', 'workflow', 'custom'
    )
  );
--> statement-breakpoint

ALTER TABLE "app_capabilities"
  ADD COLUMN "connection_id" text,
  ADD COLUMN "active" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_capabilities"
  ADD CONSTRAINT "app_capabilities_connection_id_app_connections_id_fk"
  FOREIGN KEY ("connection_id") REFERENCES "public"."app_connections"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "app_capabilities_connection_idx"
  ON "app_capabilities" ("connection_id");
--> statement-breakpoint

UPDATE "app_capabilities" capability
SET "connection_id" = snapshot."server_id",
    "active" = false,
    "updated_at" = now()
FROM "mcp_capabilities" discovered
JOIN "mcp_capability_snapshots" snapshot
  ON snapshot."id" = discovered."snapshot_id"
WHERE capability."metadata" ? 'mcpCapabilityId'
  AND capability."metadata" ->> 'mcpCapabilityId' = discovered."id";
--> statement-breakpoint

INSERT INTO "app_capabilities" (
  "app_key", "key", "connection_id", "active", "runtime_name",
  "display_name", "description", "group_key", "access_mode", "audience",
  "default_enabled", "default_approval_mode", "default_rate_limit_mode",
  "default_logging_mode", "default_settings", "metadata", "created_at",
  "updated_at"
)
SELECT connection."app_key",
       'mcp:' || discovered."id",
       server."id",
       snapshot."status" = 'approved',
       'mcp.app.' || connection."app_key" || '.mcp%3A' || discovered."id",
       coalesce(discovered."display_name", discovered."capability_key"),
       coalesce(
         discovered."description",
         'Capability provided by ' || discovered."provider_key" || '.'
       ),
       discovered."kind",
       CASE
         WHEN discovered."kind" IN ('tool', 'sampling', 'elicitation') THEN 'write'
         WHEN discovered."kind" IN ('task', 'logging') THEN 'status'
         WHEN discovered."kind" = 'root' THEN 'internal'
         ELSE 'read'
       END,
       'project', false, 'deny', 'default', 'full', '{}'::jsonb,
       jsonb_build_object(
         'mcpCapabilityId', discovered."id",
         'mcpServerId', server."id",
         'mcpKind', discovered."kind"
       ),
       discovered."created_at", now()
FROM "mcp_capabilities" discovered
JOIN "mcp_capability_snapshots" snapshot
  ON snapshot."id" = discovered."snapshot_id"
JOIN "mcp_servers" server ON server."id" = snapshot."server_id"
JOIN "app_connections" connection ON connection."id" = server."id"
WHERE EXISTS (
  SELECT 1
  FROM "app_capabilities" legacy
  WHERE legacy."app_key" = connection."app_key"
    AND legacy."key" = discovered."kind" || ':' || discovered."capability_key"
    AND legacy."metadata" ? 'mcpCapabilityId'
)
ON CONFLICT ("app_key", "key") DO UPDATE
SET "connection_id" = excluded."connection_id",
    "active" = excluded."active",
    "runtime_name" = excluded."runtime_name",
    "display_name" = excluded."display_name",
    "description" = excluded."description",
    "group_key" = excluded."group_key",
    "access_mode" = excluded."access_mode",
    "metadata" = excluded."metadata",
    "updated_at" = excluded."updated_at";
--> statement-breakpoint

INSERT INTO "environment_app_capability_grants" (
  "environment_id", "app_key", "capability_key", "enabled",
  "approval_mode", "logging_mode", "rate_limit_mode", "settings",
  "created_at", "updated_at"
)
SELECT legacy_grant."environment_id", connection."app_key",
       'mcp:' || discovered."id", legacy_grant."enabled",
       legacy_grant."approval_mode", legacy_grant."logging_mode",
       legacy_grant."rate_limit_mode", legacy_grant."settings",
       legacy_grant."created_at", now()
FROM "mcp_capabilities" discovered
JOIN "mcp_capability_snapshots" snapshot
  ON snapshot."id" = discovered."snapshot_id" AND snapshot."status" = 'approved'
JOIN "mcp_servers" server ON server."id" = snapshot."server_id"
JOIN "app_connections" connection ON connection."id" = server."id"
JOIN "environment_app_capability_grants" legacy_grant
  ON legacy_grant."environment_id" = server."environment_id"
 AND legacy_grant."app_key" = connection."app_key"
 AND legacy_grant."capability_key" = discovered."kind" || ':' || discovered."capability_key"
ON CONFLICT ("environment_id", "app_key", "capability_key") DO NOTHING;
--> statement-breakpoint

INSERT INTO "project_app_capability_policies" (
  "project_id", "app_key", "capability_key", "enabled", "approval_mode",
  "logging_mode", "rate_limit_mode", "settings", "created_at", "updated_at"
)
SELECT legacy_policy."project_id", connection."app_key",
       'mcp:' || discovered."id", legacy_policy."enabled",
       legacy_policy."approval_mode", legacy_policy."logging_mode",
       legacy_policy."rate_limit_mode", legacy_policy."settings",
       legacy_policy."created_at", now()
FROM "mcp_capabilities" discovered
JOIN "mcp_capability_snapshots" snapshot
  ON snapshot."id" = discovered."snapshot_id" AND snapshot."status" = 'approved'
JOIN "mcp_servers" server ON server."id" = snapshot."server_id"
JOIN "app_connections" connection ON connection."id" = server."id"
JOIN "project_environment_bindings" binding
  ON binding."environment_id" = server."environment_id"
JOIN "project_app_capability_policies" legacy_policy
  ON legacy_policy."project_id" = binding."project_id"
 AND legacy_policy."app_key" = connection."app_key"
 AND legacy_policy."capability_key" = discovered."kind" || ':' || discovered."capability_key"
ON CONFLICT ("project_id", "app_key", "capability_key") DO NOTHING;
--> statement-breakpoint

DELETE FROM "project_app_capability_policies" policy
USING "app_capabilities" capability
WHERE policy."app_key" = capability."app_key"
  AND policy."capability_key" = capability."key"
  AND capability."connection_id" IS NOT NULL
  AND capability."active" = false
  AND capability."metadata" ? 'mcpCapabilityId';
--> statement-breakpoint
DELETE FROM "environment_app_capability_grants" grant_row
USING "app_capabilities" capability
WHERE grant_row."app_key" = capability."app_key"
  AND grant_row."capability_key" = capability."key"
  AND capability."connection_id" IS NOT NULL
  AND capability."active" = false
  AND capability."metadata" ? 'mcpCapabilityId';
