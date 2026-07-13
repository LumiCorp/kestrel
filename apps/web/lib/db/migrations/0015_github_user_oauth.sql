ALTER TABLE "environment_workspaces"
  RENAME COLUMN "source_connection_id" TO "source_resource_id";

ALTER TABLE "environment_workspaces"
  ADD CONSTRAINT "environment_workspaces_source_resource_fk"
  FOREIGN KEY ("source_resource_id")
  REFERENCES "tool_connection_resources"("id")
  ON DELETE RESTRICT;

ALTER TABLE "environment_workspaces"
  DROP CONSTRAINT "environment_workspaces_source_check";

ALTER TABLE "environment_workspaces"
  ADD CONSTRAINT "environment_workspaces_source_check" CHECK (
    ("source_type" = 'blank' AND "source_resource_id" IS NULL AND "source_repository" IS NULL)
    OR
    ("source_type" = 'github' AND "source_resource_id" IS NOT NULL AND "source_repository" IS NOT NULL)
  );

DROP INDEX "tool_connection_resources_installation_idx";

CREATE TABLE "user_tool_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "provider_key" text NOT NULL,
  "user_id" text NOT NULL,
  "auth_account_id" text NOT NULL,
  "status" text DEFAULT 'connected' NOT NULL,
  "provider_account_id" text NOT NULL,
  "provider_login" text NOT NULL,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "failure_code" text,
  "last_synced_at" timestamp with time zone,
  "disconnected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_tool_connections_organization_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "user_tool_connections_provider_fk"
    FOREIGN KEY ("provider_key") REFERENCES "tool_providers"("key") ON DELETE CASCADE,
  CONSTRAINT "user_tool_connections_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE,
  CONSTRAINT "user_tool_connections_auth_account_fk"
    FOREIGN KEY ("auth_account_id") REFERENCES "account"("id") ON DELETE CASCADE,
  CONSTRAINT "user_tool_connections_status_check"
    CHECK ("status" IN ('connected', 'degraded', 'disconnected'))
);

CREATE UNIQUE INDEX "user_tool_connections_org_provider_user_idx"
  ON "user_tool_connections" ("organization_id", "provider_key", "user_id");
CREATE UNIQUE INDEX "user_tool_connections_org_provider_account_idx"
  ON "user_tool_connections" ("organization_id", "provider_key", "auth_account_id");
CREATE INDEX "user_tool_connections_status_idx"
  ON "user_tool_connections" ("organization_id", "provider_key", "status");

CREATE TABLE "user_tool_connection_resources" (
  "connection_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "can_pull" boolean DEFAULT true NOT NULL,
  "can_push" boolean DEFAULT false NOT NULL,
  "can_admin" boolean DEFAULT false NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_tool_connection_resources_pk"
    PRIMARY KEY ("connection_id", "resource_id"),
  CONSTRAINT "user_tool_connection_resources_connection_fk"
    FOREIGN KEY ("connection_id") REFERENCES "user_tool_connections"("id") ON DELETE CASCADE,
  CONSTRAINT "user_tool_connection_resources_resource_fk"
    FOREIGN KEY ("resource_id") REFERENCES "tool_connection_resources"("id") ON DELETE CASCADE
);

CREATE INDEX "user_tool_connection_resources_resource_idx"
  ON "user_tool_connection_resources" ("resource_id");
