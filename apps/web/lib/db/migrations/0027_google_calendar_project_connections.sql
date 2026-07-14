INSERT INTO "tool_providers" (
  "key", "display_name", "description", "type", "auth_type", "metadata",
  "created_at", "updated_at"
)
VALUES (
  'google_workspace',
  'Google Workspace',
  'User-owned Google Workspace services connected to shared Projects.',
  'oauth',
  'oauth',
  '{"icon":"google","category":"integration","connectionModel":"user_oauth"}'::jsonb,
  now(),
  now()
)
ON CONFLICT ("key") DO UPDATE SET
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "type" = excluded."type",
  "auth_type" = excluded."auth_type",
  "metadata" = excluded."metadata",
  "updated_at" = now();

INSERT INTO "tool_capabilities" (
  "provider_key", "key", "runtime_name", "display_name", "description",
  "access_mode", "default_enabled", "default_approval_mode",
  "default_surface_access", "default_rate_limit_mode",
  "default_logging_mode", "default_settings", "metadata",
  "created_at", "updated_at"
)
VALUES
  ('google_workspace', 'calendar.events.read', 'googleCalendarListEvents',
   'List calendar events', 'List events from the connected user''s primary calendar.',
   'read', true, 'auto', '{"chat":true,"admin":false}'::jsonb,
   'default', 'metadata_only', '{}'::jsonb, '{"audience":"self"}'::jsonb, now(), now()),
  ('google_workspace', 'calendar.events.create', 'googleCalendarCreateEvent',
   'Create calendar events', 'Create events on the connected user''s primary calendar.',
   'write', true, 'ask', '{"chat":true,"admin":false}'::jsonb,
   'default', 'metadata_only', '{}'::jsonb, '{"audience":"self"}'::jsonb, now(), now()),
  ('google_workspace', 'calendar.events.update', 'googleCalendarUpdateEvent',
   'Update calendar events', 'Update events on the connected user''s primary calendar.',
   'write', true, 'ask', '{"chat":true,"admin":false}'::jsonb,
   'default', 'metadata_only', '{}'::jsonb, '{"audience":"self"}'::jsonb, now(), now()),
  ('google_workspace', 'calendar.events.delete', 'googleCalendarDeleteEvent',
   'Delete calendar events', 'Delete events from the connected user''s primary calendar.',
   'write', true, 'ask', '{"chat":true,"admin":false}'::jsonb,
   'default', 'metadata_only', '{}'::jsonb, '{"audience":"self"}'::jsonb, now(), now()),
  ('google_workspace', 'calendar.availability.subjects', 'googleCalendarListAvailabilitySubjects',
   'List availability subjects', 'List Project teammates who opted in to free/busy sharing.',
   'read', true, 'auto', '{"chat":true,"admin":false}'::jsonb,
   'default', 'metadata_only', '{}'::jsonb, '{"audience":"self"}'::jsonb, now(), now()),
  ('google_workspace', 'calendar.availability.read', 'googleCalendarCheckAvailability',
   'Check teammate availability', 'Read normalized free/busy intervals for opted-in Project teammates.',
   'read', true, 'auto', '{"chat":true,"admin":false}'::jsonb,
   'default', 'metadata_only', '{}'::jsonb, '{"audience":"self_or_project"}'::jsonb, now(), now())
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

CREATE TABLE IF NOT EXISTS "project_user_tool_capabilities" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "connection_id" text NOT NULL REFERENCES "user_tool_connections"("id") ON DELETE CASCADE,
  "provider_key" text NOT NULL,
  "capability_key" text NOT NULL,
  "audience" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_user_tool_capabilities_capability_fk"
    FOREIGN KEY ("provider_key", "capability_key")
    REFERENCES "tool_capabilities"("provider_key", "key") ON DELETE CASCADE,
  CONSTRAINT "project_user_tool_capabilities_audience_check"
    CHECK ("audience" IN ('self', 'project'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_user_tool_capabilities_scope_idx"
  ON "project_user_tool_capabilities" (
    "project_id", "connection_id", "provider_key", "capability_key", "audience"
  );
CREATE INDEX IF NOT EXISTS "project_user_tool_capabilities_project_idx"
  ON "project_user_tool_capabilities" ("project_id");
CREATE INDEX IF NOT EXISTS "project_user_tool_capabilities_connection_idx"
  ON "project_user_tool_capabilities" ("connection_id");
CREATE INDEX IF NOT EXISTS "project_user_tool_capabilities_subject_idx"
  ON "project_user_tool_capabilities" (
    "project_id", "provider_key", "capability_key", "audience", "enabled"
  );

INSERT INTO "organization_tool_providers" (
  "organization_id", "provider_key", "enabled", "settings", "created_at", "updated_at"
)
SELECT "id", 'google_workspace', true, '{}'::jsonb, now(), now()
FROM "organization"
ON CONFLICT ("organization_id", "provider_key") DO NOTHING;

INSERT INTO "organization_tool_capabilities" (
  "organization_id", "provider_key", "capability_key", "enabled",
  "approval_mode", "surface_access", "rate_limit_mode", "logging_mode",
  "settings", "created_at", "updated_at"
)
SELECT
  organization."id",
  capability."provider_key",
  capability."key",
  capability."default_enabled",
  capability."default_approval_mode",
  capability."default_surface_access",
  capability."default_rate_limit_mode",
  capability."default_logging_mode",
  COALESCE(capability."default_settings", '{}'::jsonb),
  now(),
  now()
FROM "organization" organization
CROSS JOIN "tool_capabilities" capability
WHERE capability."provider_key" = 'google_workspace'
ON CONFLICT ("organization_id", "provider_key", "capability_key") DO NOTHING;

INSERT INTO "environment_capability_grants" (
  "id", "environment_id", "provider_key", "capability_key",
  "approval_mode", "logging_mode", "rate_limit_mode", "settings",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  environment."id",
  capability."provider_key",
  capability."key",
  capability."default_approval_mode",
  capability."default_logging_mode",
  capability."default_rate_limit_mode",
  COALESCE(capability."default_settings", '{}'::jsonb),
  now(),
  now()
FROM "environments" environment
CROSS JOIN "tool_capabilities" capability
WHERE capability."provider_key" = 'google_workspace'
  AND environment."archived_at" IS NULL
ON CONFLICT ("environment_id", "provider_key", "capability_key")
  WHERE "resource_id" IS NULL
DO NOTHING;
