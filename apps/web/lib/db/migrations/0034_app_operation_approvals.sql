CREATE TABLE "app_operation_approvals" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "environment_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "requested_execution_id" text NOT NULL,
  "consumed_execution_id" text,
  "actor_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "app_key" text NOT NULL,
  "capability_key" text NOT NULL,
  "connection_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "resource_type" text NOT NULL,
  "operation_key" text NOT NULL,
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
  CONSTRAINT "app_operation_approvals_status_check"
    CHECK ("status" IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
  CONSTRAINT "app_operation_approvals_payload_hash_check"
    CHECK (length("payload_hash") = 64),
  CONSTRAINT "app_operation_approvals_lifecycle_check" CHECK (
    ("status" = 'pending' AND "decided_by_user_id" IS NULL AND "decided_at" IS NULL AND "consumed_execution_id" IS NULL AND "consumed_at" IS NULL)
    OR ("status" IN ('approved', 'denied') AND "decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "consumed_execution_id" IS NULL AND "consumed_at" IS NULL)
    OR ("status" = 'consumed' AND "decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "consumed_execution_id" IS NOT NULL AND "consumed_at" IS NOT NULL)
    OR ("status" = 'expired' AND "consumed_execution_id" IS NULL AND "consumed_at" IS NULL)
  ),
  CONSTRAINT "app_operation_approvals_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "app_operation_approvals_environment_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE cascade,
  CONSTRAINT "app_operation_approvals_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "environment_workspaces"("id") ON DELETE cascade,
  CONSTRAINT "app_operation_approvals_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE cascade,
  CONSTRAINT "app_operation_approvals_requested_execution_fk" FOREIGN KEY ("requested_execution_id") REFERENCES "environment_run_executions"("id") ON DELETE cascade,
  CONSTRAINT "app_operation_approvals_consumed_execution_fk" FOREIGN KEY ("consumed_execution_id") REFERENCES "environment_run_executions"("id") ON DELETE restrict,
  CONSTRAINT "app_operation_approvals_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE restrict,
  CONSTRAINT "app_operation_approvals_decider_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE restrict,
  CONSTRAINT "app_operation_approvals_capability_fk" FOREIGN KEY ("app_key", "capability_key") REFERENCES "app_capabilities"("app_key", "key") ON DELETE restrict,
  CONSTRAINT "app_operation_approvals_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "app_connections"("id") ON DELETE restrict,
  CONSTRAINT "app_operation_approvals_resource_fk" FOREIGN KEY ("resource_id") REFERENCES "app_connection_resources"("id") ON DELETE restrict
);

CREATE UNIQUE INDEX "app_operation_approvals_runtime_idx"
  ON "app_operation_approvals" ("organization_id", "runtime_approval_id");
CREATE INDEX "app_operation_approvals_thread_status_idx"
  ON "app_operation_approvals" ("organization_id", "thread_id", "status");
CREATE INDEX "app_operation_approvals_expiry_idx"
  ON "app_operation_approvals" ("status", "expires_at");
CREATE INDEX "app_operation_approvals_execution_idx"
  ON "app_operation_approvals" ("requested_execution_id");
