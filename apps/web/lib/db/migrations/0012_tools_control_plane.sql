CREATE TABLE IF NOT EXISTS "tool_providers" (
  "key" text PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "description" text,
  "type" text NOT NULL,
  "auth_type" text NOT NULL DEFAULT 'none',
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_capabilities" (
  "provider_key" text NOT NULL REFERENCES "tool_providers"("key") ON DELETE cascade,
  "key" text NOT NULL,
  "runtime_name" text,
  "display_name" text NOT NULL,
  "description" text,
  "access_mode" text NOT NULL,
  "default_enabled" boolean DEFAULT true NOT NULL,
  "default_approval_mode" text DEFAULT 'auto' NOT NULL,
  "default_surface_access" jsonb DEFAULT '{"chat": true, "admin": false}'::jsonb NOT NULL,
  "default_rate_limit_mode" text DEFAULT 'default' NOT NULL,
  "default_logging_mode" text DEFAULT 'full' NOT NULL,
  "default_settings" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("provider_key", "key")
);

CREATE TABLE IF NOT EXISTS "organization_tool_providers" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "provider_key" text NOT NULL REFERENCES "tool_providers"("key") ON DELETE cascade,
  "enabled" boolean DEFAULT true NOT NULL,
  "settings" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("organization_id", "provider_key")
);

CREATE TABLE IF NOT EXISTS "organization_tool_capabilities" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "provider_key" text NOT NULL,
  "capability_key" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "approval_mode" text DEFAULT 'auto' NOT NULL,
  "surface_access" jsonb DEFAULT '{"chat": true, "admin": false}'::jsonb NOT NULL,
  "rate_limit_mode" text DEFAULT 'default' NOT NULL,
  "logging_mode" text DEFAULT 'full' NOT NULL,
  "settings" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("organization_id", "provider_key", "capability_key"),
  CONSTRAINT "organization_tool_capabilities_capability_fk"
    FOREIGN KEY ("provider_key", "capability_key")
    REFERENCES "tool_capabilities"("provider_key", "key")
    ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS "organization_tool_connections" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "provider_key" text NOT NULL REFERENCES "tool_providers"("key") ON DELETE cascade,
  "auth_source" text NOT NULL,
  "status" text DEFAULT 'not_configured' NOT NULL,
  "account_id" text,
  "credential_ref" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("organization_id", "provider_key")
);

CREATE INDEX IF NOT EXISTS "tool_providers_type_idx"
  ON "tool_providers" ("type");
CREATE INDEX IF NOT EXISTS "tool_providers_auth_type_idx"
  ON "tool_providers" ("auth_type");
CREATE INDEX IF NOT EXISTS "tool_capabilities_provider_idx"
  ON "tool_capabilities" ("provider_key");
CREATE INDEX IF NOT EXISTS "tool_capabilities_runtime_name_idx"
  ON "tool_capabilities" ("runtime_name");
CREATE INDEX IF NOT EXISTS "tool_capabilities_access_mode_idx"
  ON "tool_capabilities" ("access_mode");
CREATE INDEX IF NOT EXISTS "organization_tool_providers_provider_idx"
  ON "organization_tool_providers" ("provider_key");
CREATE INDEX IF NOT EXISTS "organization_tool_capabilities_provider_idx"
  ON "organization_tool_capabilities" ("provider_key");
CREATE INDEX IF NOT EXISTS "organization_tool_connections_status_idx"
  ON "organization_tool_connections" ("status");

INSERT INTO "tool_providers" ("key", "display_name", "description", "type", "auth_type", "metadata")
VALUES
  ('built_in.weather', 'Weather', 'Get current weather for a location.', 'built_in', 'system', '{"category":"built_in","icon":"cloud-sun"}'::jsonb),
  ('built_in.knowledge_search', 'Knowledge Search', 'Search uploaded knowledge documents.', 'built_in', 'system', '{"category":"built_in","icon":"book-open"}'::jsonb),
  ('built_in.sandbox', 'Sandbox', 'Inspect synced source content with read-only shell commands.', 'built_in', 'system', '{"category":"built_in","icon":"terminal"}'::jsonb),
  ('built_in.artifacts', 'Artifacts', 'Create and update chat artifacts.', 'built_in', 'system', '{"category":"built_in","icon":"file-text"}'::jsonb),
  ('github', 'GitHub', 'GitHub bot and future GitHub tool connectivity.', 'oauth', 'env', '{"category":"integration","icon":"github"}'::jsonb),
  ('discord', 'Discord', 'Discord bot runtime and guild binding status.', 'inbound_adapter', 'env', '{"category":"integration","icon":"message-square"}'::jsonb)
ON CONFLICT ("key") DO UPDATE
SET
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "type" = excluded."type",
  "auth_type" = excluded."auth_type",
  "metadata" = excluded."metadata",
  "updated_at" = now();

INSERT INTO "tool_capabilities" (
  "provider_key",
  "key",
  "runtime_name",
  "display_name",
  "description",
  "access_mode",
  "default_enabled",
  "default_approval_mode",
  "default_surface_access",
  "default_rate_limit_mode",
  "default_logging_mode",
  "default_settings",
  "metadata"
)
VALUES
  ('built_in.weather', 'getWeather', 'getWeather', 'Get Weather', 'Get current weather and geocoded location data.', 'read', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'full', '{"units":"fahrenheit","timeoutMs":8000,"retryCount":1}'::jsonb, '{"settingsSchema":{"units":["fahrenheit","celsius"]}}'::jsonb),
  ('built_in.knowledge_search', 'searchKnowledgeDocuments', 'searchKnowledgeDocuments', 'Search Knowledge Documents', 'Search uploaded knowledge documents for grouped evidence.', 'read', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'metadata_only', '{"defaultLimit":5}'::jsonb, '{}'::jsonb),
  ('built_in.sandbox', 'bash', 'bash', 'Sandbox Bash', 'Run one read-only shell command in the synced sandbox.', 'internal', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'strict', 'metadata_only', '{}'::jsonb, '{}'::jsonb),
  ('built_in.sandbox', 'bash_batch', 'bash_batch', 'Sandbox Bash Batch', 'Run multiple read-only shell commands in the synced sandbox.', 'internal', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'strict', 'metadata_only', '{}'::jsonb, '{}'::jsonb),
  ('built_in.artifacts', 'createDocument', 'createDocument', 'Create Document', 'Create an artifact document beside the conversation.', 'write', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'full', '{}'::jsonb, '{}'::jsonb),
  ('built_in.artifacts', 'updateDocument', 'updateDocument', 'Update Document', 'Update an existing artifact document.', 'write', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'full', '{}'::jsonb, '{}'::jsonb),
  ('built_in.artifacts', 'requestSuggestions', 'requestSuggestions', 'Request Suggestions', 'Request suggestions for an artifact document.', 'read', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'full', '{}'::jsonb, '{}'::jsonb),
  ('github', 'github.read', NULL, 'GitHub Read Tools', 'Placeholder GitHub read capabilities for the org connection.', 'read', false, 'auto', '{"chat": false, "admin": true}'::jsonb, 'default', 'metadata_only', '{"allowedRepos":[]}'::jsonb, '{"placeholder":true}'::jsonb),
  ('github', 'github.write', NULL, 'GitHub Write Tools', 'Placeholder GitHub write capabilities for the org connection.', 'write', false, 'ask', '{"chat": false, "admin": true}'::jsonb, 'strict', 'full', '{"allowedRepos":[],"writeEnabled":false}'::jsonb, '{"placeholder":true}'::jsonb),
  ('discord', 'discord.status', NULL, 'Discord Runtime', 'Discord bot runtime and guild binding status.', 'status', true, 'auto', '{"chat": false, "admin": true}'::jsonb, 'off', 'metadata_only', '{}'::jsonb, '{"placeholder":true}'::jsonb)
ON CONFLICT ("provider_key", "key") DO UPDATE
SET
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
