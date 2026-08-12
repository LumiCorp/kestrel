ALTER TABLE "environment_run_executions"
  ADD COLUMN "last_runtime_event_id" text;
--> statement-breakpoint
INSERT INTO "tool_capabilities" (
  "provider_key", "key", "runtime_name", "display_name", "description",
  "access_mode", "default_enabled", "default_approval_mode",
  "default_surface_access", "default_rate_limit_mode", "default_logging_mode",
  "default_settings", "metadata"
)
VALUES (
  'built_in.previews', 'inspect', 'workspace.preview.inspect',
  'Inspect preview port', 'Check whether a local Workspace port is listening.',
  'status', true, 'auto', '{"chat":true,"admin":false}'::jsonb,
  'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb
)
ON CONFLICT ("provider_key", "key") DO UPDATE SET
  "runtime_name" = excluded."runtime_name",
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "access_mode" = excluded."access_mode",
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "app_capabilities" (
  "app_key", "key", "runtime_name", "display_name", "description",
  "group_key", "access_mode", "audience", "default_enabled",
  "default_approval_mode", "default_rate_limit_mode", "default_logging_mode",
  "default_settings", "metadata", "created_at", "updated_at"
)
VALUES (
  'built_in.previews', 'inspect', 'workspace.preview.inspect',
  'Inspect preview port', 'Check whether a local Workspace port is listening.',
  'general', 'status', 'project', true, 'auto', 'off', 'metadata_only',
  '{}'::jsonb, '{}'::jsonb, now(), now()
)
ON CONFLICT ("app_key", "key") DO UPDATE SET
  "runtime_name" = excluded."runtime_name",
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "access_mode" = excluded."access_mode",
  "updated_at" = now();
