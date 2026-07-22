ALTER TABLE "environments"
  ADD COLUMN IF NOT EXISTS "gateway_service_token_hash" text;

ALTER TABLE "environment_workspaces"
  ADD COLUMN IF NOT EXISTS "service_token_hash" text;

ALTER TABLE "app_definitions"
  DROP CONSTRAINT IF EXISTS "app_definitions_delivery_check";
ALTER TABLE "app_definitions"
  ADD CONSTRAINT "app_definitions_delivery_check" CHECK (
    "delivery" IN ('native', 'lifecycle', 'oauth', 'api_key', 'mcp', 'webhook', 'source')
  );

ALTER TABLE "app_credentials"
  DROP CONSTRAINT IF EXISTS "app_credentials_kind_check";
ALTER TABLE "app_credentials"
  ADD CONSTRAINT "app_credentials_kind_check" CHECK (
    "kind" IN ('api_key', 'oauth', 'secret_headers', 'ngrok_agent')
  );

CREATE UNIQUE INDEX IF NOT EXISTS "app_connections_ngrok_wildcard_domain_idx"
  ON "app_connections" (("delivery_config" ->> 'wildcardDomain'))
  WHERE "app_key" = 'ngrok'
    AND "owner_type" = 'environment'
    AND "status" IN ('connected', 'degraded');

CREATE TABLE IF NOT EXISTS "workspace_preview_leases" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "environment_id" text NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "environment_workspaces"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "run_id" text NOT NULL REFERENCES "environment_run_executions"("id") ON DELETE CASCADE,
  "actor_id" text NOT NULL,
  "connection_id" text NOT NULL REFERENCES "app_connections"("id") ON DELETE RESTRICT,
  "port" integer NOT NULL,
  "name" text,
  "hostname" text NOT NULL,
  "status" text DEFAULT 'provisioning' NOT NULL,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "maximum_expires_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_preview_leases_organization_environment_fk"
    FOREIGN KEY ("organization_id", "environment_id")
    REFERENCES "environments"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "workspace_preview_leases_status_check" CHECK (
    "status" IN ('provisioning', 'active', 'closing', 'closed', 'expired', 'failed')
  ),
  CONSTRAINT "workspace_preview_leases_port_check" CHECK (
    "port" BETWEEN 1024 AND 65535 AND "port" NOT IN (43104, 43105)
  ),
  CONSTRAINT "workspace_preview_leases_expiry_check" CHECK (
    "expires_at" <= "maximum_expires_at"
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_preview_leases_hostname_idx"
  ON "workspace_preview_leases" ("hostname");
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_preview_leases_active_port_idx"
  ON "workspace_preview_leases" ("workspace_id", "port")
  WHERE "status" IN ('provisioning', 'active', 'closing');
CREATE INDEX IF NOT EXISTS "workspace_preview_leases_environment_status_idx"
  ON "workspace_preview_leases" ("environment_id", "status");
CREATE INDEX IF NOT EXISTS "workspace_preview_leases_workspace_status_idx"
  ON "workspace_preview_leases" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "workspace_preview_leases_expiry_idx"
  ON "workspace_preview_leases" ("status", "expires_at");

CREATE TABLE IF NOT EXISTS "environment_model_grants" (
  "run_id" text PRIMARY KEY NOT NULL REFERENCES "environment_run_executions"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "environment_id" text NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "environment_workspaces"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "gateway_id" text NOT NULL,
  "raw_model_id" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "environment_model_grants_organization_environment_fk"
    FOREIGN KEY ("organization_id", "environment_id")
    REFERENCES "environments"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "environment_model_grants_gateway_model_fk"
    FOREIGN KEY ("gateway_id", "raw_model_id")
    REFERENCES "ai_gateway_models"("gateway_id", "raw_model_id") ON DELETE RESTRICT,
  CONSTRAINT "environment_model_grants_status_check" CHECK (
    "status" IN ('active', 'closed')
  )
);

CREATE INDEX IF NOT EXISTS "environment_model_grants_environment_status_idx"
  ON "environment_model_grants" ("environment_id", "status");
CREATE INDEX IF NOT EXISTS "environment_model_grants_workspace_status_idx"
  ON "environment_model_grants" ("workspace_id", "status");

INSERT INTO "app_definitions" (
  "key", "slug", "display_name", "description", "category", "kind",
  "connection_model", "connection_requirement", "delivery", "install_mode",
  "icon", "published", "metadata", "created_at", "updated_at"
)
VALUES (
  'ngrok', 'ngrok', 'ngrok Previews',
  'Publish short-lived anonymous HTTPS URLs for HTTP apps through the trusted Environment gateway.',
  'engineering', 'external', 'environment', 'required', 'lifecycle', 'inherited',
  'external-link', true,
  '{"provider":"ngrok","credentialKind":"ngrok_agent","authMethods":["agent_token"]}'::jsonb,
  now(), now()
)
ON CONFLICT ("key") DO UPDATE SET
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

INSERT INTO "app_capabilities" (
  "app_key", "key", "runtime_name", "display_name", "description",
  "group_key", "access_mode", "audience", "default_enabled",
  "default_approval_mode", "default_rate_limit_mode", "default_logging_mode",
  "default_settings", "metadata", "created_at", "updated_at"
)
VALUES
  ('ngrok', 'publish', 'workspace.preview.publish', 'Publish preview', 'Expose a listening local HTTP port at a temporary public URL.', 'previews', 'write', 'project', true, 'auto', 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('ngrok', 'list', 'workspace.preview.list', 'List previews', 'List active public Workspace previews.', 'previews', 'status', 'project', true, 'auto', 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('ngrok', 'renew', 'workspace.preview.renew', 'Renew preview', 'Extend a preview within its maximum lifetime.', 'previews', 'write', 'project', true, 'auto', 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('ngrok', 'close', 'workspace.preview.close', 'Close preview', 'Permanently close a public preview URL.', 'previews', 'write', 'project', true, 'auto', 'off', 'metadata_only', '{}'::jsonb, '{}'::jsonb, now(), now())
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
