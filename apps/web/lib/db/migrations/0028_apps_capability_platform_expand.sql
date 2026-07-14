CREATE TABLE IF NOT EXISTS "app_definitions" (
  "key" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text NOT NULL,
  "category" text NOT NULL,
  "kind" text NOT NULL,
  "connection_model" text NOT NULL,
  "delivery" text NOT NULL,
  "install_mode" text NOT NULL,
  "icon" text,
  "published" boolean DEFAULT true NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "app_definitions_category_check" CHECK (
    "category" IN (
      'kestrel', 'search_research', 'productivity', 'engineering',
      'knowledge_sources', 'communication', 'custom'
    )
  ),
  CONSTRAINT "app_definitions_kind_check" CHECK (
    "kind" IN ('built_in', 'external', 'custom')
  ),
  CONSTRAINT "app_definitions_connection_model_check" CHECK (
    "connection_model" IN ('none', 'personal', 'environment')
  ),
  CONSTRAINT "app_definitions_delivery_check" CHECK (
    "delivery" IN ('native', 'oauth', 'api_key', 'mcp', 'webhook', 'source')
  ),
  CONSTRAINT "app_definitions_install_mode_check" CHECK (
    "install_mode" IN ('inherited', 'explicit')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "app_definitions_slug_idx"
  ON "app_definitions" ("slug");
CREATE INDEX IF NOT EXISTS "app_definitions_category_idx"
  ON "app_definitions" ("category");
CREATE INDEX IF NOT EXISTS "app_definitions_published_idx"
  ON "app_definitions" ("published");

CREATE TABLE IF NOT EXISTS "app_capabilities" (
  "app_key" text NOT NULL REFERENCES "app_definitions"("key") ON DELETE CASCADE,
  "key" text NOT NULL,
  "runtime_name" text,
  "display_name" text NOT NULL,
  "description" text NOT NULL,
  "group_key" text DEFAULT 'general' NOT NULL,
  "access_mode" text NOT NULL,
  "audience" text DEFAULT 'project' NOT NULL,
  "default_enabled" boolean DEFAULT true NOT NULL,
  "default_approval_mode" text DEFAULT 'auto' NOT NULL,
  "default_rate_limit_mode" text DEFAULT 'default' NOT NULL,
  "default_logging_mode" text DEFAULT 'metadata_only' NOT NULL,
  "default_settings" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("app_key", "key"),
  CONSTRAINT "app_capabilities_access_mode_check" CHECK (
    "access_mode" IN ('read', 'write', 'status', 'internal')
  ),
  CONSTRAINT "app_capabilities_audience_check" CHECK (
    "audience" IN ('self', 'project', 'both')
  ),
  CONSTRAINT "app_capabilities_approval_mode_check" CHECK (
    "default_approval_mode" IN ('auto', 'ask', 'deny')
  ),
  CONSTRAINT "app_capabilities_rate_limit_mode_check" CHECK (
    "default_rate_limit_mode" IN ('default', 'strict', 'off')
  ),
  CONSTRAINT "app_capabilities_logging_mode_check" CHECK (
    "default_logging_mode" IN ('full', 'metadata_only', 'minimal')
  )
);

CREATE INDEX IF NOT EXISTS "app_capabilities_runtime_name_idx"
  ON "app_capabilities" ("runtime_name");
CREATE INDEX IF NOT EXISTS "app_capabilities_group_idx"
  ON "app_capabilities" ("app_key", "group_key");

CREATE TABLE IF NOT EXISTS "app_installations" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "app_key" text NOT NULL REFERENCES "app_definitions"("key") ON DELETE CASCADE,
  "status" text DEFAULT 'installed' NOT NULL,
  "installed_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "settings" jsonb,
  "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("organization_id", "app_key"),
  CONSTRAINT "app_installations_status_check" CHECK (
    "status" IN ('installed', 'disabled')
  )
);

CREATE INDEX IF NOT EXISTS "app_installations_status_idx"
  ON "app_installations" ("organization_id", "status");

CREATE TABLE IF NOT EXISTS "app_credentials" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "environment_id" text NOT NULL,
  "app_key" text NOT NULL REFERENCES "app_definitions"("key") ON DELETE RESTRICT,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "encrypted_payload" text NOT NULL,
  "envelope_version" text DEFAULT 'kapp:v1' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "app_credentials_organization_environment_fk"
    FOREIGN KEY ("organization_id", "environment_id")
    REFERENCES "environments"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "app_credentials_kind_check" CHECK (
    "kind" IN ('api_key', 'oauth', 'secret_headers')
  ),
  CONSTRAINT "app_credentials_status_check" CHECK (
    "status" IN ('active', 'revoked')
  ),
  CONSTRAINT "app_credentials_encrypted_payload_check" CHECK (
    "encrypted_payload" LIKE 'kapp:v1:%' OR "encrypted_payload" LIKE 'kmcp:v1:%'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "app_credentials_environment_app_name_idx"
  ON "app_credentials" ("environment_id", "app_key", "name")
  WHERE "status" = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS "app_credentials_environment_id_idx"
  ON "app_credentials" ("environment_id", "id");
CREATE INDEX IF NOT EXISTS "app_credentials_app_status_idx"
  ON "app_credentials" ("app_key", "status");

CREATE TABLE IF NOT EXISTS "app_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "app_key" text NOT NULL REFERENCES "app_definitions"("key") ON DELETE CASCADE,
  "owner_type" text NOT NULL,
  "environment_id" text,
  "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "auth_account_id" text REFERENCES "account"("id") ON DELETE SET NULL,
  "credential_id" text,
  "name" text NOT NULL,
  "status" text DEFAULT 'connected' NOT NULL,
  "external_account_id" text,
  "external_account_label" text,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "delivery_config" jsonb,
  "failure_code" text,
  "failure_message" text,
  "last_health_at" timestamp with time zone,
  "disconnected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "app_connections_organization_environment_fk"
    FOREIGN KEY ("organization_id", "environment_id")
    REFERENCES "environments"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "app_connections_environment_credential_fk"
    FOREIGN KEY ("environment_id", "credential_id")
    REFERENCES "app_credentials"("environment_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "app_connections_owner_type_check" CHECK (
    "owner_type" IN ('system', 'personal', 'environment', 'deployment_managed')
  ),
  CONSTRAINT "app_connections_status_check" CHECK (
    "status" IN ('connected', 'degraded', 'disconnected')
  ),
  CONSTRAINT "app_connections_owner_scope_check" CHECK (
    ("owner_type" = 'system' AND "environment_id" IS NULL AND "user_id" IS NULL AND "credential_id" IS NULL)
    OR
    ("owner_type" = 'personal' AND "user_id" IS NOT NULL AND "environment_id" IS NULL AND "credential_id" IS NULL)
    OR
    ("owner_type" IN ('environment', 'deployment_managed') AND "environment_id" IS NOT NULL AND "user_id" IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "app_connections_personal_name_idx"
  ON "app_connections" ("organization_id", "app_key", "user_id", "name")
  WHERE "owner_type" = 'personal';
CREATE UNIQUE INDEX IF NOT EXISTS "app_connections_environment_name_idx"
  ON "app_connections" ("environment_id", "app_key", "name")
  WHERE "owner_type" IN ('environment', 'deployment_managed');
CREATE INDEX IF NOT EXISTS "app_connections_org_app_status_idx"
  ON "app_connections" ("organization_id", "app_key", "status");
CREATE INDEX IF NOT EXISTS "app_connections_user_idx"
  ON "app_connections" ("user_id", "status");

CREATE TABLE IF NOT EXISTS "app_connection_resources" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL REFERENCES "app_connections"("id") ON DELETE CASCADE,
  "external_id" text NOT NULL,
  "resource_type" text NOT NULL,
  "label" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "permissions" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "app_connection_resources_external_idx"
  ON "app_connection_resources" ("connection_id", "resource_type", "external_id");
CREATE INDEX IF NOT EXISTS "app_connection_resources_connection_idx"
  ON "app_connection_resources" ("connection_id");

CREATE TABLE IF NOT EXISTS "environment_app_capability_grants" (
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE CASCADE,
  "app_key" text NOT NULL,
  "capability_key" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "approval_mode" text DEFAULT 'deny' NOT NULL,
  "logging_mode" text DEFAULT 'metadata_only' NOT NULL,
  "rate_limit_mode" text DEFAULT 'default' NOT NULL,
  "settings" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("environment_id", "app_key", "capability_key"),
  CONSTRAINT "environment_app_capability_grants_capability_fk"
    FOREIGN KEY ("app_key", "capability_key")
    REFERENCES "app_capabilities"("app_key", "key") ON DELETE CASCADE,
  CONSTRAINT "environment_app_capability_grants_approval_check" CHECK (
    "approval_mode" IN ('auto', 'ask', 'deny')
  ),
  CONSTRAINT "environment_app_capability_grants_logging_check" CHECK (
    "logging_mode" IN ('full', 'metadata_only', 'minimal')
  ),
  CONSTRAINT "environment_app_capability_grants_rate_limit_check" CHECK (
    "rate_limit_mode" IN ('default', 'strict', 'off')
  )
);

CREATE INDEX IF NOT EXISTS "environment_app_capability_grants_app_idx"
  ON "environment_app_capability_grants" ("environment_id", "app_key");

CREATE TABLE IF NOT EXISTS "project_apps" (
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "app_key" text NOT NULL REFERENCES "app_definitions"("key") ON DELETE CASCADE,
  "enabled" boolean DEFAULT true NOT NULL,
  "added_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "settings" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("project_id", "app_key")
);

CREATE INDEX IF NOT EXISTS "project_apps_app_enabled_idx"
  ON "project_apps" ("app_key", "enabled");

CREATE TABLE IF NOT EXISTS "project_app_connections" (
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "app_key" text NOT NULL,
  "connection_id" text NOT NULL REFERENCES "app_connections"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "is_default" boolean DEFAULT false NOT NULL,
  "added_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("project_id", "app_key", "connection_id"),
  CONSTRAINT "project_app_connections_project_app_fk"
    FOREIGN KEY ("project_id", "app_key")
    REFERENCES "project_apps"("project_id", "app_key") ON DELETE CASCADE,
  CONSTRAINT "project_app_connections_scope_check" CHECK (
    ("scope" = 'shared' AND "user_id" IS NULL)
    OR
    ("scope" = 'personal' AND "user_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_app_connections_shared_default_idx"
  ON "project_app_connections" ("project_id", "app_key")
  WHERE "scope" = 'shared' AND "is_default" = true;
CREATE UNIQUE INDEX IF NOT EXISTS "project_app_connections_personal_default_idx"
  ON "project_app_connections" ("project_id", "app_key", "user_id")
  WHERE "scope" = 'personal' AND "is_default" = true;
CREATE INDEX IF NOT EXISTS "project_app_connections_connection_idx"
  ON "project_app_connections" ("connection_id");

CREATE TABLE IF NOT EXISTS "project_app_capability_policies" (
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "app_key" text NOT NULL,
  "capability_key" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "approval_mode" text DEFAULT 'deny' NOT NULL,
  "logging_mode" text DEFAULT 'metadata_only' NOT NULL,
  "rate_limit_mode" text DEFAULT 'default' NOT NULL,
  "settings" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("project_id", "app_key", "capability_key"),
  CONSTRAINT "project_app_capability_policies_project_app_fk"
    FOREIGN KEY ("project_id", "app_key")
    REFERENCES "project_apps"("project_id", "app_key") ON DELETE CASCADE,
  CONSTRAINT "project_app_capability_policies_capability_fk"
    FOREIGN KEY ("app_key", "capability_key")
    REFERENCES "app_capabilities"("app_key", "key") ON DELETE CASCADE,
  CONSTRAINT "project_app_capability_policies_approval_check" CHECK (
    "approval_mode" IN ('auto', 'ask', 'deny')
  ),
  CONSTRAINT "project_app_capability_policies_logging_check" CHECK (
    "logging_mode" IN ('full', 'metadata_only', 'minimal')
  ),
  CONSTRAINT "project_app_capability_policies_rate_limit_check" CHECK (
    "rate_limit_mode" IN ('default', 'strict', 'off')
  )
);

CREATE INDEX IF NOT EXISTS "project_app_capability_policies_app_idx"
  ON "project_app_capability_policies" ("project_id", "app_key");

INSERT INTO "app_definitions" (
  "key", "slug", "display_name", "description", "category", "kind",
  "connection_model", "delivery", "install_mode", "icon", "published",
  "metadata", "created_at", "updated_at"
)
SELECT
  provider."key",
  regexp_replace(lower(provider."key"), '[^a-z0-9]+', '-', 'g'),
  provider."display_name",
  COALESCE(provider."description", provider."display_name"),
  CASE
    WHEN provider."key" = 'tavily' THEN 'search_research'
    WHEN provider."type" = 'built_in' THEN 'kestrel'
    WHEN provider."type" = 'source_connector' THEN 'knowledge_sources'
    WHEN provider."key" = 'github' THEN 'engineering'
    WHEN provider."key" = 'google_workspace' THEN 'productivity'
    WHEN provider."key" = 'discord' THEN 'communication'
    WHEN provider."type" = 'custom_imported' THEN 'custom'
    ELSE 'productivity'
  END,
  CASE
    WHEN provider."type" = 'built_in' THEN 'built_in'
    WHEN provider."type" = 'custom_imported' THEN 'custom'
    ELSE 'external'
  END,
  CASE
    WHEN provider."type" = 'built_in' THEN 'none'
    WHEN provider."key" = 'google_workspace' THEN 'personal'
    ELSE 'environment'
  END,
  CASE
    WHEN provider."type" = 'built_in' THEN 'native'
    WHEN provider."type" = 'custom_imported' THEN 'mcp'
    WHEN provider."type" = 'source_connector' THEN 'source'
    WHEN provider."type" = 'inbound_adapter' THEN 'webhook'
    WHEN provider."auth_type" = 'oauth' THEN 'oauth'
    WHEN provider."auth_type" IN ('api_key', 'env') THEN 'api_key'
    ELSE 'native'
  END,
  CASE WHEN provider."type" = 'built_in' THEN 'inherited' ELSE 'explicit' END,
  provider."metadata" ->> 'icon',
  true,
  COALESCE(provider."metadata", '{}'::jsonb),
  COALESCE(provider."created_at", now()),
  now()
FROM "tool_providers" provider
ON CONFLICT ("key") DO UPDATE SET
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "icon" = excluded."icon",
  "metadata" = excluded."metadata",
  "updated_at" = now();

INSERT INTO "app_definitions" (
  "key", "slug", "display_name", "description", "category", "kind",
  "connection_model", "delivery", "install_mode", "icon", "published",
  "metadata", "created_at", "updated_at"
)
VALUES (
  'tavily', 'tavily', 'Tavily',
  'Search, extract, crawl, map, and research the web with source-aware results.',
  'search_research', 'external', 'environment', 'api_key', 'explicit',
  '/integrations/tavily.png', true,
  '{"provider":"tavily","credentialKind":"api_key"}'::jsonb,
  now(), now()
)
ON CONFLICT ("key") DO UPDATE SET
  "display_name" = excluded."display_name",
  "description" = excluded."description",
  "category" = excluded."category",
  "connection_model" = excluded."connection_model",
  "delivery" = excluded."delivery",
  "install_mode" = excluded."install_mode",
  "icon" = excluded."icon",
  "published" = true,
  "metadata" = excluded."metadata",
  "updated_at" = now();

INSERT INTO "app_capabilities" (
  "app_key", "key", "runtime_name", "display_name", "description",
  "group_key", "access_mode", "audience", "default_enabled",
  "default_approval_mode", "default_rate_limit_mode", "default_logging_mode",
  "default_settings", "metadata", "created_at", "updated_at"
)
SELECT
  capability."provider_key",
  capability."key",
  capability."runtime_name",
  capability."display_name",
  COALESCE(capability."description", capability."display_name"),
  CASE
    WHEN capability."key" LIKE 'calendar.%' THEN 'calendar'
    WHEN capability."key" LIKE 'repository.%' OR capability."key" LIKE 'pull_request.%'
      OR capability."key" LIKE 'issue.%' OR capability."key" LIKE 'merge.%'
      OR capability."key" LIKE 'release.%' OR capability."key" LIKE 'workflow.%'
      THEN 'repositories'
    ELSE 'general'
  END,
  capability."access_mode",
  CASE
    WHEN capability."metadata" ->> 'audience' = 'self' THEN 'self'
    WHEN capability."metadata" ->> 'audience' = 'self_or_project' THEN 'both'
    ELSE 'project'
  END,
  capability."default_enabled",
  capability."default_approval_mode",
  capability."default_rate_limit_mode",
  capability."default_logging_mode",
  COALESCE(capability."default_settings", '{}'::jsonb),
  COALESCE(capability."metadata", '{}'::jsonb),
  COALESCE(capability."created_at", now()),
  now()
FROM "tool_capabilities" capability
JOIN "app_definitions" app ON app."key" = capability."provider_key"
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

INSERT INTO "app_capabilities" (
  "app_key", "key", "runtime_name", "display_name", "description",
  "group_key", "access_mode", "audience", "default_enabled",
  "default_approval_mode", "default_rate_limit_mode", "default_logging_mode",
  "default_settings", "metadata", "created_at", "updated_at"
)
VALUES
  ('tavily', 'search', 'internet.search', 'Search the web', 'Search the web and return source-aware results.', 'search', 'read', 'project', true, 'auto', 'default', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('tavily', 'search_advanced', 'internet.search_advanced', 'Advanced search', 'Run advanced web searches with domain, depth, and result controls.', 'search', 'read', 'project', true, 'auto', 'default', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('tavily', 'news', 'internet.news', 'Search news', 'Search recent news with source-aware results.', 'search', 'read', 'project', true, 'auto', 'default', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('tavily', 'images', 'internet.images', 'Search images', 'Find relevant web images and their source pages.', 'search', 'read', 'project', true, 'auto', 'default', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('tavily', 'extract', 'internet.extract', 'Extract pages', 'Extract readable content from selected web pages.', 'content', 'read', 'project', true, 'auto', 'default', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('tavily', 'crawl', 'internet.crawl', 'Crawl a site', 'Crawl a selected site within configured limits.', 'research', 'read', 'project', true, 'ask', 'strict', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('tavily', 'map', 'internet.map', 'Map a site', 'Discover and map pages within a selected site.', 'research', 'read', 'project', true, 'ask', 'strict', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('tavily', 'research', 'internet.research', 'Run research', 'Run a longer, multi-source Tavily research task.', 'research', 'read', 'project', true, 'ask', 'strict', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('tavily', 'research_status', 'internet.research_status', 'Check research status', 'Check the status of a Tavily research task.', 'research', 'status', 'project', true, 'auto', 'default', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('tavily', 'usage', 'internet.usage', 'View usage', 'View Tavily plan and usage metadata for administrators.', 'administration', 'status', 'project', false, 'deny', 'strict', 'minimal', '{}'::jsonb, '{"adminOnly":true}'::jsonb, now(), now())
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

INSERT INTO "app_installations" (
  "organization_id", "app_key", "status", "settings",
  "installed_at", "created_at", "updated_at"
)
SELECT
  organization_provider."organization_id",
  organization_provider."provider_key",
  CASE WHEN organization_provider."enabled" THEN 'installed' ELSE 'disabled' END,
  COALESCE(organization_provider."settings", '{}'::jsonb),
  COALESCE(organization_provider."created_at", now()),
  COALESCE(organization_provider."created_at", now()),
  now()
FROM "organization_tool_providers" organization_provider
JOIN "app_definitions" app ON app."key" = organization_provider."provider_key"
ON CONFLICT ("organization_id", "app_key") DO UPDATE SET
  "status" = excluded."status",
  "settings" = excluded."settings",
  "disabled_at" = CASE WHEN excluded."status" = 'disabled' THEN now() ELSE NULL END,
  "updated_at" = now();

INSERT INTO "app_installations" (
  "organization_id", "app_key", "status", "settings",
  "installed_at", "created_at", "updated_at"
)
SELECT organization."id", app."key", 'installed', '{}'::jsonb, now(), now(), now()
FROM "organization" organization
CROSS JOIN "app_definitions" app
WHERE app."install_mode" = 'inherited'
ON CONFLICT ("organization_id", "app_key") DO UPDATE SET
  "status" = 'installed',
  "disabled_at" = NULL,
  "updated_at" = now();

INSERT INTO "app_credentials" (
  "id", "organization_id", "environment_id", "app_key", "name", "kind",
  "encrypted_payload", "envelope_version", "status", "created_by_user_id",
  "last_used_at", "revoked_at", "metadata", "created_at", "updated_at"
)
SELECT
  credential."id",
  credential."organization_id",
  credential."environment_id",
  server."provider_key",
  credential."name",
  credential."kind",
  credential."encrypted_payload",
  'kmcp:v1',
  CASE WHEN credential."status" = 'active' THEN 'active' ELSE 'revoked' END,
  credential."created_by_user_id",
  credential."last_used_at",
  credential."revoked_at",
  jsonb_build_object(
    'legacySource', 'mcp_credentials',
    'legacyCredentialStatus', credential."status"
  ),
  credential."created_at",
  credential."updated_at"
FROM "mcp_credentials" credential
JOIN "mcp_servers" server ON server."credential_id" = credential."id"
ON CONFLICT ("id") DO NOTHING;

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
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "app_connections" (
  "id", "organization_id", "app_key", "owner_type", "environment_id",
  "name", "status", "external_account_id", "external_account_label",
  "scopes", "delivery_config", "failure_message", "last_health_at",
  "created_at", "updated_at"
)
SELECT
  'environment:' || connection."organization_id" || ':' || connection."provider_key",
  connection."organization_id",
  connection."provider_key",
  'environment',
  environment."id",
  COALESCE(NULLIF(connection."account_id", ''), 'Organization connection'),
  CASE
    WHEN connection."status" IN ('connected', 'env_backed') THEN 'connected'
    WHEN connection."status" = 'degraded' THEN 'degraded'
    ELSE 'disconnected'
  END,
  connection."account_id",
  connection."account_id",
  '[]'::jsonb,
  COALESCE(connection."metadata", '{}'::jsonb),
  connection."metadata" ->> 'lastError',
  connection."updated_at",
  connection."created_at",
  connection."updated_at"
FROM "organization_tool_connections" connection
JOIN "app_definitions" app ON app."key" = connection."provider_key"
JOIN LATERAL (
  SELECT candidate."id"
  FROM "environments" candidate
  WHERE candidate."organization_id" = connection."organization_id"
    AND candidate."archived_at" IS NULL
  ORDER BY candidate."is_default" DESC, candidate."created_at" ASC
  LIMIT 1
) environment ON true
WHERE app."connection_model" = 'environment'
  AND app."kind" <> 'custom'
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "app_connections" (
  "id", "organization_id", "app_key", "owner_type", "environment_id",
  "credential_id", "name", "status", "scopes", "delivery_config",
  "failure_code", "failure_message", "last_health_at", "created_at", "updated_at"
)
SELECT
  server."id",
  server."organization_id",
  server."provider_key",
  'environment',
  server."environment_id",
  server."credential_id",
  server."name",
  CASE
    WHEN server."status" = 'ready' THEN 'connected'
    WHEN server."status" = 'degraded' THEN 'degraded'
    ELSE 'disconnected'
  END,
  '[]'::jsonb,
  jsonb_build_object(
    'mcpServerId', server."id",
    'sourceType', server."source_type",
    'transport', server."transport",
    'remoteUrl', server."remote_url",
    'ociImageReference', server."oci_image_reference"
  ),
  server."failure_code",
  server."failure_message",
  server."last_health_at",
  server."created_at",
  server."updated_at"
FROM "mcp_servers" server
ON CONFLICT ("id") DO NOTHING;

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
  jsonb_build_object('pull', mapping."can_pull", 'push', mapping."can_push", 'admin', mapping."can_admin"),
  COALESCE(resource."metadata", '{}'::jsonb),
  resource."created_at",
  resource."updated_at"
FROM "user_tool_connection_resources" mapping
JOIN "user_tool_connections" legacy_connection ON legacy_connection."id" = mapping."connection_id"
JOIN "app_connections" connection ON connection."id" = legacy_connection."id"
JOIN "tool_connection_resources" resource ON resource."id" = mapping."resource_id"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "environment_app_capability_grants" (
  "environment_id", "app_key", "capability_key", "enabled",
  "approval_mode", "logging_mode", "rate_limit_mode", "settings",
  "created_at", "updated_at"
)
SELECT
  legacy_grant."environment_id",
  legacy_grant."provider_key",
  legacy_grant."capability_key",
  legacy_grant."approval_mode" <> 'deny',
  legacy_grant."approval_mode",
  legacy_grant."logging_mode",
  legacy_grant."rate_limit_mode",
  COALESCE(legacy_grant."settings", '{}'::jsonb),
  legacy_grant."created_at",
  legacy_grant."updated_at"
FROM "environment_capability_grants" legacy_grant
JOIN "app_capabilities" capability
  ON capability."app_key" = legacy_grant."provider_key"
  AND capability."key" = legacy_grant."capability_key"
WHERE legacy_grant."resource_id" IS NULL
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
  capability."project_id",
  capability."provider_key",
  true,
  '{}'::jsonb,
  min(capability."created_at") OVER (PARTITION BY capability."project_id", capability."provider_key"),
  now()
FROM "project_user_tool_capabilities" capability
ON CONFLICT ("project_id", "app_key") DO UPDATE SET
  "enabled" = true,
  "updated_at" = now();

INSERT INTO "project_apps" (
  "project_id", "app_key", "enabled", "settings", "created_at", "updated_at"
)
SELECT DISTINCT
  restriction."project_id",
  restriction."provider_key",
  true,
  '{}'::jsonb,
  min(restriction."created_at") OVER (PARTITION BY restriction."project_id", restriction."provider_key"),
  now()
FROM "project_capability_restrictions" restriction
ON CONFLICT ("project_id", "app_key") DO UPDATE SET
  "enabled" = true,
  "updated_at" = now();

INSERT INTO "project_app_connections" (
  "project_id", "app_key", "connection_id", "scope", "user_id",
  "is_default", "added_by_user_id", "created_at", "updated_at"
)
SELECT DISTINCT ON (
  capability."project_id", capability."provider_key", capability."connection_id"
)
  capability."project_id",
  capability."provider_key",
  capability."connection_id",
  'personal',
  connection."user_id",
  true,
  connection."user_id",
  capability."created_at",
  now()
FROM "project_user_tool_capabilities" capability
JOIN "app_connections" connection ON connection."id" = capability."connection_id"
ORDER BY capability."project_id", capability."provider_key", capability."connection_id", capability."created_at"
ON CONFLICT ("project_id", "app_key", "connection_id") DO NOTHING;

INSERT INTO "project_app_capability_policies" (
  "project_id", "app_key", "capability_key", "enabled", "approval_mode",
  "logging_mode", "rate_limit_mode", "settings", "created_at", "updated_at"
)
SELECT
  capability."project_id",
  capability."provider_key",
  capability."capability_key",
  bool_or(capability."enabled"),
  app_capability."default_approval_mode",
  app_capability."default_logging_mode",
  app_capability."default_rate_limit_mode",
  '{}'::jsonb,
  min(capability."created_at"),
  now()
FROM "project_user_tool_capabilities" capability
JOIN "app_capabilities" app_capability
  ON app_capability."app_key" = capability."provider_key"
  AND app_capability."key" = capability."capability_key"
GROUP BY
  capability."project_id", capability."provider_key", capability."capability_key",
  app_capability."default_approval_mode", app_capability."default_logging_mode",
  app_capability."default_rate_limit_mode"
ON CONFLICT ("project_id", "app_key", "capability_key") DO UPDATE SET
  "enabled" = excluded."enabled",
  "approval_mode" = excluded."approval_mode",
  "logging_mode" = excluded."logging_mode",
  "rate_limit_mode" = excluded."rate_limit_mode",
  "updated_at" = now();

INSERT INTO "project_app_capability_policies" (
  "project_id", "app_key", "capability_key", "enabled", "approval_mode",
  "logging_mode", "rate_limit_mode", "settings", "created_at", "updated_at"
)
SELECT
  restriction."project_id",
  restriction."provider_key",
  restriction."capability_key",
  restriction."enabled",
  restriction."approval_mode",
  app_capability."default_logging_mode",
  app_capability."default_rate_limit_mode",
  '{}'::jsonb,
  restriction."created_at",
  restriction."updated_at"
FROM "project_capability_restrictions" restriction
JOIN "app_capabilities" app_capability
  ON app_capability."app_key" = restriction."provider_key"
  AND app_capability."key" = restriction."capability_key"
WHERE restriction."resource_id" IS NULL
ON CONFLICT ("project_id", "app_key", "capability_key") DO UPDATE SET
  "enabled" = excluded."enabled",
  "approval_mode" = excluded."approval_mode",
  "updated_at" = now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "app_connections" connection
    LEFT JOIN "app_definitions" app ON app."key" = connection."app_key"
    WHERE app."key" IS NULL
  ) THEN
    RAISE EXCEPTION 'Apps expansion produced a connection with no app definition';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "project_app_capability_policies" policy
    JOIN "project_environment_bindings" binding ON binding."project_id" = policy."project_id"
    JOIN "environment_app_capability_grants" environment_grant
      ON environment_grant."environment_id" = binding."environment_id"
      AND environment_grant."app_key" = policy."app_key"
      AND environment_grant."capability_key" = policy."capability_key"
    WHERE policy."enabled" = true
      AND (
        environment_grant."enabled" = false
        OR environment_grant."approval_mode" = 'deny'
        OR (environment_grant."approval_mode" = 'ask' AND policy."approval_mode" = 'auto')
      )
  ) THEN
    RAISE EXCEPTION 'Apps expansion would widen Project capability policy beyond its Environment';
  END IF;
END $$;
