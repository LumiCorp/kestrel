CREATE TABLE "github_action_approvals" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "environment_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "requested_execution_id" text NOT NULL,
  "consumed_execution_id" text,
  "actor_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "repository" text NOT NULL,
  "operation" text NOT NULL,
  "runtime_approval_id" text NOT NULL,
  "payload_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "decided_by_user_id" text,
  "decided_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "github_action_approvals_organization_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "github_action_approvals_environment_fk"
    FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE,
  CONSTRAINT "github_action_approvals_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "environment_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "github_action_approvals_thread_fk"
    FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE,
  CONSTRAINT "github_action_approvals_requested_execution_fk"
    FOREIGN KEY ("requested_execution_id") REFERENCES "environment_run_executions"("id") ON DELETE CASCADE,
  CONSTRAINT "github_action_approvals_consumed_execution_fk"
    FOREIGN KEY ("consumed_execution_id") REFERENCES "environment_run_executions"("id") ON DELETE RESTRICT,
  CONSTRAINT "github_action_approvals_actor_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE RESTRICT,
  CONSTRAINT "github_action_approvals_decider_fk"
    FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT,
  CONSTRAINT "github_action_approvals_resource_fk"
    FOREIGN KEY ("resource_id") REFERENCES "tool_connection_resources"("id") ON DELETE RESTRICT,
  CONSTRAINT "github_action_approvals_operation_check" CHECK (
    "operation" IN ('issue.create', 'pull_request.create', 'pull_request.merge', 'release.create', 'workflow.dispatch')
  ),
  CONSTRAINT "github_action_approvals_status_check" CHECK (
    "status" IN ('pending', 'approved', 'denied', 'consumed', 'expired')
  ),
  CONSTRAINT "github_action_approvals_payload_hash_check" CHECK (
    "payload_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "github_action_approvals_lifecycle_check" CHECK (
    ("status" = 'pending' AND "decided_at" IS NULL AND "decided_by_user_id" IS NULL AND "consumed_at" IS NULL AND "consumed_execution_id" IS NULL)
    OR
    ("status" IN ('approved', 'denied') AND "decided_at" IS NOT NULL AND "decided_by_user_id" IS NOT NULL AND "consumed_at" IS NULL AND "consumed_execution_id" IS NULL)
    OR
    ("status" = 'consumed' AND "decided_at" IS NOT NULL AND "decided_by_user_id" IS NOT NULL AND "consumed_at" IS NOT NULL AND "consumed_execution_id" IS NOT NULL)
    OR
    ("status" = 'expired' AND "consumed_at" IS NULL AND "consumed_execution_id" IS NULL)
  )
);

CREATE UNIQUE INDEX "github_action_approvals_runtime_idx"
  ON "github_action_approvals" ("organization_id", "runtime_approval_id");
CREATE INDEX "github_action_approvals_thread_status_idx"
  ON "github_action_approvals" ("organization_id", "thread_id", "status");
CREATE INDEX "github_action_approvals_expiry_idx"
  ON "github_action_approvals" ("status", "expires_at");
CREATE INDEX "github_action_approvals_execution_idx"
  ON "github_action_approvals" ("requested_execution_id");
