CREATE TABLE "environments" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE restrict,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "region" text NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "fly_app_name" text,
  "fly_network_name" text,
  "fly_gateway_machine_id" text,
  "router_url" text,
  "router_image" text,
  "runtime_template" text DEFAULT 'kestrel-standard-v1' NOT NULL,
  "runtime_image" text,
  "idle_timeout_minutes" integer DEFAULT 15 NOT NULL,
  "last_health_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "environments_status_check" CHECK (
    "status" IN ('requested', 'provisioning', 'ready', 'degraded', 'deleting', 'deleted', 'failed')
  ),
  CONSTRAINT "environments_idle_timeout_check" CHECK ("idle_timeout_minutes" > 0)
);

CREATE UNIQUE INDEX "environments_org_slug_idx"
  ON "environments" ("organization_id", "slug");
CREATE UNIQUE INDEX "environments_org_default_idx"
  ON "environments" ("organization_id")
  WHERE "is_default" = true AND "archived_at" IS NULL;
CREATE UNIQUE INDEX "environments_fly_app_name_idx"
  ON "environments" ("fly_app_name")
  WHERE "fly_app_name" IS NOT NULL;
CREATE INDEX "environments_org_status_idx"
  ON "environments" ("organization_id", "status");

CREATE TABLE "tool_connection_resources" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "provider_key" text NOT NULL REFERENCES "tool_providers"("key") ON DELETE cascade,
  "external_id" text NOT NULL,
  "resource_type" text NOT NULL,
  "label" text NOT NULL,
  "metadata" jsonb,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "tool_connection_resources_external_idx"
  ON "tool_connection_resources" ("organization_id", "provider_key", "external_id");
CREATE UNIQUE INDEX "tool_connection_resources_installation_idx"
  ON "tool_connection_resources" ("provider_key", "external_id")
  WHERE "resource_type" = 'installation';
CREATE INDEX "tool_connection_resources_provider_idx"
  ON "tool_connection_resources" ("organization_id", "provider_key");

CREATE TABLE "environment_workspaces" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE cascade,
  "project_id" text REFERENCES "projects"("id") ON DELETE cascade,
  "standalone_thread_id" text REFERENCES "threads"("id") ON DELETE cascade,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE restrict,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "source_type" text DEFAULT 'blank' NOT NULL,
  "source_connection_id" text,
  "source_repository" text,
  "source_default_branch" text,
  "status" text DEFAULT 'requested' NOT NULL,
  "fly_machine_id" text,
  "fly_volume_id" text,
  "runtime_image" text,
  "last_activity_at" timestamp with time zone,
  "last_health_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "environment_workspaces_kind_check" CHECK ("kind" IN ('project', 'scratch')),
  CONSTRAINT "environment_workspaces_source_type_check" CHECK ("source_type" IN ('blank', 'github')),
  CONSTRAINT "environment_workspaces_status_check" CHECK (
    "status" IN ('requested', 'provisioning', 'stopped', 'starting', 'ready', 'stopping', 'degraded', 'deleting', 'deleted', 'failed')
  ),
  CONSTRAINT "environment_workspaces_owner_check" CHECK (
    ("kind" = 'project' AND "project_id" IS NOT NULL AND "standalone_thread_id" IS NULL)
    OR
    ("kind" = 'scratch' AND "project_id" IS NULL AND "standalone_thread_id" IS NOT NULL)
  ),
  CONSTRAINT "environment_workspaces_source_check" CHECK (
    ("source_type" = 'blank' AND "source_repository" IS NULL)
    OR
    ("source_type" = 'github' AND "source_repository" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "environment_workspaces_project_idx"
  ON "environment_workspaces" ("environment_id", "project_id")
  WHERE "project_id" IS NOT NULL AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "environment_workspaces_thread_idx"
  ON "environment_workspaces" ("environment_id", "standalone_thread_id")
  WHERE "standalone_thread_id" IS NOT NULL AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "environment_workspaces_machine_idx"
  ON "environment_workspaces" ("fly_machine_id")
  WHERE "fly_machine_id" IS NOT NULL;
CREATE UNIQUE INDEX "environment_workspaces_volume_idx"
  ON "environment_workspaces" ("fly_volume_id")
  WHERE "fly_volume_id" IS NOT NULL;
CREATE INDEX "environment_workspaces_org_status_idx"
  ON "environment_workspaces" ("organization_id", "status");
CREATE INDEX "environment_workspaces_environment_idx"
  ON "environment_workspaces" ("environment_id");

CREATE TABLE "project_environment_bindings" (
  "project_id" text PRIMARY KEY NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE restrict,
  "bound_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "project_environment_bindings_org_idx"
  ON "project_environment_bindings" ("organization_id");
CREATE INDEX "project_environment_bindings_environment_idx"
  ON "project_environment_bindings" ("environment_id");

CREATE TABLE "thread_execution_bindings" (
  "thread_id" text PRIMARY KEY NOT NULL REFERENCES "threads"("id") ON DELETE cascade,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE restrict,
  "workspace_id" text NOT NULL REFERENCES "environment_workspaces"("id") ON DELETE restrict,
  "source" text NOT NULL,
  "bound_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_execution_bindings_source_check" CHECK (
    "source" IN ('thread', 'project', 'organization')
  )
);

CREATE INDEX "thread_execution_bindings_org_idx"
  ON "thread_execution_bindings" ("organization_id");
CREATE INDEX "thread_execution_bindings_environment_idx"
  ON "thread_execution_bindings" ("environment_id");
CREATE INDEX "thread_execution_bindings_workspace_idx"
  ON "thread_execution_bindings" ("workspace_id");

CREATE TABLE "environment_run_executions" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE restrict,
  "workspace_id" text NOT NULL REFERENCES "environment_workspaces"("id") ON DELETE restrict,
  "thread_id" text NOT NULL REFERENCES "threads"("id") ON DELETE cascade,
  "project_id" text REFERENCES "projects"("id") ON DELETE set null,
  "project_context_revision_id" text REFERENCES "project_context_revisions"("id") ON DELETE set null,
  "actor_id" text NOT NULL,
  "runtime_image" text NOT NULL,
  "effective_capabilities" jsonb NOT NULL,
  "status" text DEFAULT 'routed' NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "environment_run_executions_status_check" CHECK (
    "status" IN ('routed', 'running', 'completed', 'failed', 'cancelled')
  )
);

CREATE INDEX "environment_run_executions_thread_created_idx"
  ON "environment_run_executions" ("thread_id", "created_at");
CREATE INDEX "environment_run_executions_workspace_status_idx"
  ON "environment_run_executions" ("workspace_id", "status");
CREATE INDEX "environment_run_executions_org_created_idx"
  ON "environment_run_executions" ("organization_id", "created_at");

CREATE TABLE "environment_operations" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE cascade,
  "workspace_id" text REFERENCES "environment_workspaces"("id") ON DELETE cascade,
  "requested_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "type" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "stage" text DEFAULT 'requested' NOT NULL,
  "idempotency_key" text NOT NULL,
  "provider_request_id" text,
  "attempt" integer DEFAULT 0 NOT NULL,
  "input" jsonb,
  "result" jsonb,
  "error_code" text,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "environment_operations_type_check" CHECK (
    "type" IN (
      'environment.provision', 'environment.delete', 'workspace.provision',
      'workspace.start', 'workspace.stop', 'workspace.rebuild', 'workspace.delete',
      'workspace.backup', 'workspace.restore', 'workspace.reconcile'
    )
  ),
  CONSTRAINT "environment_operations_status_check" CHECK (
    "status" IN ('queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT "environment_operations_attempt_check" CHECK ("attempt" >= 0)
);

CREATE UNIQUE INDEX "environment_operations_idempotency_idx"
  ON "environment_operations" ("organization_id", "idempotency_key");
CREATE INDEX "environment_operations_environment_status_idx"
  ON "environment_operations" ("environment_id", "status");
CREATE INDEX "environment_operations_workspace_idx"
  ON "environment_operations" ("workspace_id");

CREATE TABLE "environment_applications" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE cascade,
  "workspace_id" text NOT NULL REFERENCES "environment_workspaces"("id") ON DELETE cascade,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "working_directory" text NOT NULL,
  "start_command" text NOT NULL,
  "port" integer NOT NULL,
  "health_path" text,
  "audience" text DEFAULT 'workspace' NOT NULL,
  "desired_state" text DEFAULT 'running' NOT NULL,
  "status" text DEFAULT 'registered' NOT NULL,
  "process_id" text,
  "last_health_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "environment_applications_port_check" CHECK ("port" BETWEEN 1024 AND 65535),
  CONSTRAINT "environment_applications_audience_check" CHECK ("audience" = 'workspace'),
  CONSTRAINT "environment_applications_desired_state_check" CHECK (
    "desired_state" IN ('running', 'stopped')
  ),
  CONSTRAINT "environment_applications_status_check" CHECK (
    "status" IN ('registered', 'starting', 'running', 'stopped', 'failed')
  )
);

CREATE UNIQUE INDEX "environment_applications_workspace_slug_idx"
  ON "environment_applications" ("workspace_id", "slug");
CREATE INDEX "environment_applications_environment_idx"
  ON "environment_applications" ("environment_id");
CREATE INDEX "environment_applications_workspace_status_idx"
  ON "environment_applications" ("workspace_id", "status");

CREATE TABLE "workspace_backups" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE cascade,
  "workspace_id" text NOT NULL REFERENCES "environment_workspaces"("id") ON DELETE cascade,
  "operation_id" text REFERENCES "environment_operations"("id") ON DELETE set null,
  "reason" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "object_key" text,
  "encryption_key_id" text,
  "checksum_sha256" text,
  "size_bytes" bigint,
  "source_revision" text,
  "manifest" jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_backups_reason_check" CHECK (
    "reason" IN ('checkpoint', 'daily', 'pre_destructive', 'pre_promotion')
  ),
  CONSTRAINT "workspace_backups_status_check" CHECK (
    "status" IN ('queued', 'creating', 'available', 'failed', 'expired')
  ),
  CONSTRAINT "workspace_backups_size_check" CHECK (
    "size_bytes" IS NULL OR "size_bytes" >= 0
  )
);

CREATE INDEX "workspace_backups_workspace_created_idx"
  ON "workspace_backups" ("workspace_id", "created_at");
CREATE INDEX "workspace_backups_expiry_idx"
  ON "workspace_backups" ("status", "expires_at");

-- Environment grants reference the granular GitHub capability catalog directly.
-- Seed it in the same migration so a new or upgraded organization does not depend
-- on visiting the generic tools administration surface before grants can be saved.
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
  (
    'github', 'repository.read', 'githubRepositoryRead', 'Read repository',
    'Clone and read an explicitly granted GitHub repository.', 'read', true,
    'auto', '{"chat": true, "admin": false}'::jsonb, 'default',
    'metadata_only', '{}'::jsonb, '{}'::jsonb
  ),
  (
    'github', 'repository.push_agent_branch', 'githubPushAgentBranch',
    'Push agent branch',
    'Push a managed worktree to a Kestrel-owned agent branch.', 'write', true,
    'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'full',
    '{}'::jsonb, '{}'::jsonb
  ),
  (
    'github', 'pull_request.write', 'githubPullRequestWrite',
    'Create and update pull requests',
    'Create or update pull requests in an explicitly granted repository.',
    'write', true, 'ask', '{"chat": true, "admin": false}'::jsonb,
    'default', 'full', '{}'::jsonb, '{}'::jsonb
  ),
  (
    'github', 'issue.write', 'githubIssueWrite', 'Create and update issues',
    'Create or update issues in an explicitly granted repository.', 'write',
    true, 'ask', '{"chat": true, "admin": false}'::jsonb, 'default', 'full',
    '{}'::jsonb, '{}'::jsonb
  ),
  (
    'github', 'merge.write', 'githubMergeWrite', 'Merge pull requests',
    'Merge an approved pull request in an explicitly granted repository.',
    'write', true, 'ask', '{"chat": true, "admin": false}'::jsonb,
    'default', 'full', '{}'::jsonb, '{}'::jsonb
  ),
  (
    'github', 'release.write', 'githubReleaseWrite', 'Create releases',
    'Create a release in an explicitly granted repository.', 'write', true,
    'ask', '{"chat": true, "admin": false}'::jsonb, 'default', 'full',
    '{}'::jsonb, '{}'::jsonb
  ),
  (
    'github', 'workflow.dispatch', 'githubWorkflowDispatch',
    'Dispatch workflows',
    'Dispatch a selected workflow in an explicitly granted repository.',
    'write', true, 'ask', '{"chat": true, "admin": false}'::jsonb,
    'default', 'full', '{}'::jsonb, '{}'::jsonb
  )
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

CREATE TABLE "environment_capability_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE cascade,
  "provider_key" text NOT NULL,
  "capability_key" text NOT NULL,
  "resource_id" text REFERENCES "tool_connection_resources"("id") ON DELETE cascade,
  "approval_mode" text DEFAULT 'deny' NOT NULL,
  "logging_mode" text DEFAULT 'full' NOT NULL,
  "rate_limit_mode" text DEFAULT 'default' NOT NULL,
  "settings" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "environment_capability_grants_capability_fk"
    FOREIGN KEY ("provider_key", "capability_key")
    REFERENCES "tool_capabilities"("provider_key", "key") ON DELETE cascade,
  CONSTRAINT "environment_capability_grants_approval_check" CHECK (
    "approval_mode" IN ('auto', 'ask', 'deny')
  ),
  CONSTRAINT "environment_capability_grants_logging_check" CHECK (
    "logging_mode" IN ('full', 'metadata_only', 'minimal')
  ),
  CONSTRAINT "environment_capability_grants_rate_limit_check" CHECK (
    "rate_limit_mode" IN ('default', 'strict', 'off')
  )
);

CREATE UNIQUE INDEX "environment_capability_grants_resource_idx"
  ON "environment_capability_grants" (
    "environment_id", "provider_key", "capability_key", "resource_id"
  ) WHERE "resource_id" IS NOT NULL;
CREATE UNIQUE INDEX "environment_capability_grants_unscoped_idx"
  ON "environment_capability_grants" ("environment_id", "provider_key", "capability_key")
  WHERE "resource_id" IS NULL;
CREATE INDEX "environment_capability_grants_environment_idx"
  ON "environment_capability_grants" ("environment_id");

CREATE TABLE "project_capability_restrictions" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "provider_key" text NOT NULL,
  "capability_key" text NOT NULL,
  "resource_id" text REFERENCES "tool_connection_resources"("id") ON DELETE cascade,
  "enabled" boolean DEFAULT false NOT NULL,
  "approval_mode" text DEFAULT 'deny' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_capability_restrictions_capability_fk"
    FOREIGN KEY ("provider_key", "capability_key")
    REFERENCES "tool_capabilities"("provider_key", "key") ON DELETE cascade,
  CONSTRAINT "project_capability_restrictions_approval_check" CHECK (
    "approval_mode" IN ('auto', 'ask', 'deny')
  )
);

CREATE UNIQUE INDEX "project_capability_restrictions_resource_idx"
  ON "project_capability_restrictions" (
    "project_id", "provider_key", "capability_key", "resource_id"
  ) WHERE "resource_id" IS NOT NULL;
CREATE UNIQUE INDEX "project_capability_restrictions_unscoped_idx"
  ON "project_capability_restrictions" ("project_id", "provider_key", "capability_key")
  WHERE "resource_id" IS NULL;
CREATE INDEX "project_capability_restrictions_project_idx"
  ON "project_capability_restrictions" ("project_id");

CREATE TABLE "environment_capability_subject_restrictions" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE cascade,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "provider_key" text NOT NULL,
  "capability_key" text NOT NULL,
  "resource_id" text REFERENCES "tool_connection_resources"("id") ON DELETE cascade,
  "enabled" boolean DEFAULT false NOT NULL,
  "approval_mode" text DEFAULT 'deny' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "environment_capability_subject_capability_fk"
    FOREIGN KEY ("provider_key", "capability_key")
    REFERENCES "tool_capabilities"("provider_key", "key") ON DELETE cascade,
  CONSTRAINT "environment_capability_subject_type_check" CHECK (
    "subject_type" IN ('actor', 'agent')
  ),
  CONSTRAINT "environment_capability_subject_approval_check" CHECK (
    "approval_mode" IN ('auto', 'ask', 'deny')
  )
);

CREATE UNIQUE INDEX "environment_capability_subject_resource_idx"
  ON "environment_capability_subject_restrictions" (
    "environment_id", "subject_type", "subject_id", "provider_key",
    "capability_key", "resource_id"
  ) WHERE "resource_id" IS NOT NULL;
CREATE UNIQUE INDEX "environment_capability_subject_unscoped_idx"
  ON "environment_capability_subject_restrictions" (
    "environment_id", "subject_type", "subject_id", "provider_key", "capability_key"
  ) WHERE "resource_id" IS NULL;
CREATE INDEX "environment_capability_subject_lookup_idx"
  ON "environment_capability_subject_restrictions" (
    "organization_id", "environment_id", "subject_type", "subject_id"
  );
