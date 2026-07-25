-- This is an irreversible maintenance-window cutover. Preview leases are
-- intentionally invalidated instead of being migrated between ingress systems.
DELETE FROM "workspace_preview_leases";
--> statement-breakpoint
DELETE FROM "app_operation_approvals"
WHERE "app_key" = 'ngrok'
   OR "connection_id" IN (
     SELECT "id"
     FROM "app_connections"
     WHERE "app_key" = 'ngrok'
        OR "credential_id" IN (
          SELECT "id"
          FROM "app_credentials"
          WHERE "app_key" = 'ngrok' OR "kind" = 'ngrok_agent'
        )
   );
--> statement-breakpoint
DELETE FROM "app_connections"
WHERE "app_key" = 'ngrok'
   OR "credential_id" IN (
     SELECT "id"
     FROM "app_credentials"
     WHERE "app_key" = 'ngrok' OR "kind" = 'ngrok_agent'
   );
--> statement-breakpoint
DELETE FROM "app_credentials"
WHERE "app_key" = 'ngrok' OR "kind" = 'ngrok_agent';
--> statement-breakpoint
DELETE FROM "mcp_servers" WHERE "provider_key" = 'ngrok';
--> statement-breakpoint
DELETE FROM "app_definitions" WHERE "key" = 'ngrok';
--> statement-breakpoint
DELETE FROM "tool_providers" WHERE "key" = 'ngrok';
--> statement-breakpoint
INSERT INTO "tool_providers" (
  "key", "display_name", "description", "type", "auth_type", "metadata"
)
VALUES (
  'built_in.previews',
  'Kestrel Edge Previews',
  'Publish anonymous HTTPS URLs for HTTP apps through the Kestrel Edge ingress.',
  'built_in',
  'system',
  '{"icon":"external-link","category":"built_in","provider":"kestrel_edge"}'::jsonb
)
ON CONFLICT ("key") DO UPDATE SET
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "type" = excluded."type",
  "auth_type" = excluded."auth_type",
  "metadata" = excluded."metadata",
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "tool_capabilities" (
  "provider_key", "key", "runtime_name", "display_name", "description",
  "access_mode", "default_enabled", "default_approval_mode",
  "default_surface_access", "default_rate_limit_mode", "default_logging_mode",
  "default_settings", "metadata"
)
VALUES
  ('built_in.previews', 'publish', 'workspace.preview.publish', 'Publish preview', 'Expose a listening local HTTP port at a public URL.', 'write', true, 'auto', '{"chat":true,"admin":false}'::jsonb, 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb),
  ('built_in.previews', 'list', 'workspace.preview.list', 'List previews', 'List active public Workspace previews.', 'status', true, 'auto', '{"chat":true,"admin":false}'::jsonb, 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb),
  ('built_in.previews', 'renew', 'workspace.preview.renew', 'Renew preview', 'Extend a preview within its maximum lifetime.', 'write', true, 'auto', '{"chat":true,"admin":false}'::jsonb, 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb),
  ('built_in.previews', 'close', 'workspace.preview.close', 'Close preview', 'Permanently close a public preview URL.', 'write', true, 'auto', '{"chat":true,"admin":false}'::jsonb, 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb)
ON CONFLICT ("provider_key", "key") DO UPDATE SET
  "runtime_name" = excluded."runtime_name",
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "access_mode" = excluded."access_mode",
  "default_enabled" = excluded."default_enabled",
  "default_approval_mode" = excluded."default_approval_mode",
  "default_surface_access" = excluded."default_surface_access",
  "default_rate_limit_mode" = excluded."default_rate_limit_mode",
  "default_logging_mode" = excluded."default_logging_mode",
  "default_settings" = excluded."default_settings",
  "metadata" = excluded."metadata",
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "app_definitions" (
  "key", "slug", "display_name", "description", "category", "kind",
  "connection_model", "connection_requirement", "delivery", "install_mode",
  "icon", "published", "metadata", "created_at", "updated_at"
)
VALUES (
  'built_in.previews',
  'built-in-previews',
  'Kestrel Edge Previews',
  'Publish anonymous HTTPS URLs for HTTP apps through the Kestrel Edge ingress.',
  'engineering',
  'built_in',
  'none',
  'none',
  'lifecycle',
  'inherited',
  'external-link',
  true,
  '{"icon":"external-link","category":"built_in","provider":"kestrel_edge","authMethods":["none"]}'::jsonb,
  now(),
  now()
)
ON CONFLICT ("key") DO UPDATE SET
  "slug" = excluded."slug",
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "category" = excluded."category",
  "kind" = excluded."kind",
  "connection_model" = excluded."connection_model",
  "connection_requirement" = excluded."connection_requirement",
  "delivery" = excluded."delivery",
  "install_mode" = excluded."install_mode",
  "icon" = excluded."icon",
  "published" = true,
  "metadata" = excluded."metadata",
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "app_capabilities" (
  "app_key", "key", "runtime_name", "display_name", "description",
  "group_key", "access_mode", "audience", "default_enabled",
  "default_approval_mode", "default_rate_limit_mode", "default_logging_mode",
  "default_settings", "metadata", "created_at", "updated_at"
)
VALUES
  ('built_in.previews', 'publish', 'workspace.preview.publish', 'Publish preview', 'Expose a listening local HTTP port at a public URL.', 'general', 'write', 'project', true, 'auto', 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('built_in.previews', 'list', 'workspace.preview.list', 'List previews', 'List active public Workspace previews.', 'general', 'status', 'project', true, 'auto', 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('built_in.previews', 'renew', 'workspace.preview.renew', 'Renew preview', 'Extend a preview within its maximum lifetime.', 'general', 'write', 'project', true, 'auto', 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('built_in.previews', 'close', 'workspace.preview.close', 'Close preview', 'Permanently close a public preview URL.', 'general', 'write', 'project', true, 'auto', 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT ("app_key", "key") DO UPDATE SET
  "runtime_name" = excluded."runtime_name",
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "group_key" = excluded."group_key",
  "access_mode" = excluded."access_mode",
  "audience" = excluded."audience",
  "default_enabled" = excluded."default_enabled",
  "default_approval_mode" = excluded."default_approval_mode",
  "default_rate_limit_mode" = excluded."default_rate_limit_mode",
  "default_logging_mode" = excluded."default_logging_mode",
  "default_settings" = excluded."default_settings",
  "metadata" = excluded."metadata",
  "updated_at" = now();
--> statement-breakpoint
DELETE FROM "organization_cost_entries"
WHERE "usage_event_id" IN (
    SELECT "id"
    FROM "organization_usage_events"
    WHERE "provider" = 'ngrok' OR "source_kind" = 'ngrok_preview_lease'
  )
   OR "rate_card_id" IN (
    SELECT "id"
    FROM "cost_rate_cards"
    WHERE "provider" = 'ngrok'
       OR "id" = 'rate_ngrok_preview_lease_20260722'
  );
--> statement-breakpoint
DELETE FROM "organization_usage_events"
WHERE "provider" = 'ngrok' OR "source_kind" = 'ngrok_preview_lease';
--> statement-breakpoint
DELETE FROM "cost_rate_cards"
WHERE "provider" = 'ngrok'
   OR "id" = 'rate_ngrok_preview_lease_20260722';
--> statement-breakpoint
DROP INDEX IF EXISTS "app_connections_ngrok_wildcard_domain_idx";
--> statement-breakpoint
ALTER TABLE "environments"
  DROP CONSTRAINT IF EXISTS "environments_preview_ingress_provider_check";
--> statement-breakpoint
ALTER TABLE "environments"
  DROP COLUMN IF EXISTS "preview_ingress_provider";
--> statement-breakpoint
ALTER TABLE "workspace_preview_leases"
  DROP CONSTRAINT IF EXISTS "workspace_preview_leases_ingress_check";
--> statement-breakpoint
ALTER TABLE "workspace_preview_leases"
  DROP CONSTRAINT IF EXISTS "workspace_preview_leases_ingress_provider_check";
--> statement-breakpoint
ALTER TABLE "workspace_preview_leases"
  DROP COLUMN IF EXISTS "ingress_provider";
--> statement-breakpoint
ALTER TABLE "workspace_preview_leases"
  DROP COLUMN IF EXISTS "connection_id";
--> statement-breakpoint
ALTER TABLE "app_credentials"
  DROP CONSTRAINT IF EXISTS "app_credentials_kind_check";
--> statement-breakpoint
ALTER TABLE "app_credentials"
  ADD CONSTRAINT "app_credentials_kind_check"
  CHECK ("kind" IN ('api_key', 'oauth', 'secret_headers'));
