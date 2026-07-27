ALTER TABLE "environments"
  ADD COLUMN "provider" text DEFAULT 'fly' NOT NULL;
--> statement-breakpoint
ALTER TABLE "environments"
  ADD CONSTRAINT "environments_provider_check"
  CHECK ("provider" IN ('fly', 'desktop'));
--> statement-breakpoint
ALTER TABLE "environments"
  ADD CONSTRAINT "environments_provider_identity_check"
  CHECK (
    "provider" = 'fly'
    OR (
      "provider" = 'desktop'
      AND "fly_app_name" IS NULL
      AND "fly_network_name" IS NULL
      AND "fly_gateway_machine_id" IS NULL
    )
  );
--> statement-breakpoint

CREATE TABLE "desktop_environment_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE cascade,
  "public_key" text NOT NULL,
  "encryption_public_key" text NOT NULL,
  "credential_hash" text NOT NULL,
  "previous_credential_hash" text,
  "previous_credential_expires_at" timestamp with time zone,
  "credential_rotated_at" timestamp with time zone,
  "status" text DEFAULT 'pending' NOT NULL,
  "capacity" integer DEFAULT 1 NOT NULL,
  "active_runs" integer DEFAULT 0 NOT NULL,
  "desktop_name" text NOT NULL,
  "desktop_version" text,
  "runtime_version" text,
  "advertised_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "approved_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "approved_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_environment_connections_status_check"
    CHECK ("status" IN ('pending', 'active', 'revoked')),
  CONSTRAINT "desktop_environment_connections_capacity_check"
    CHECK ("capacity" BETWEEN 1 AND 16),
  CONSTRAINT "desktop_environment_connections_active_runs_check"
    CHECK ("active_runs" BETWEEN 0 AND 16)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_environment_connections_environment_idx"
  ON "desktop_environment_connections" ("environment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_environment_connections_org_id_idx"
  ON "desktop_environment_connections" ("organization_id", "id");
--> statement-breakpoint
CREATE INDEX "desktop_environment_connections_org_status_idx"
  ON "desktop_environment_connections" ("organization_id", "status");
--> statement-breakpoint

CREATE TABLE "desktop_environment_enrollment_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "secret_hash" text NOT NULL,
  "public_key" text NOT NULL,
  "encryption_public_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "desktop_name" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "organization_id" text REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text REFERENCES "environments"("id") ON DELETE cascade,
  "requested_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "approved_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "expires_at" timestamp with time zone NOT NULL,
  "approved_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_environment_enrollment_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired', 'consumed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_environment_enrollment_fingerprint_idx"
  ON "desktop_environment_enrollment_requests" ("fingerprint", "id");
--> statement-breakpoint
CREATE INDEX "desktop_environment_enrollment_status_expiry_idx"
  ON "desktop_environment_enrollment_requests" ("status", "expires_at");
--> statement-breakpoint

CREATE TABLE "desktop_user_authorization_codes" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "secret_hash" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "desktop_user_authorization_codes_expiry_idx"
  ON "desktop_user_authorization_codes" ("expires_at");
--> statement-breakpoint

CREATE TABLE "desktop_user_credentials" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "family_id" text NOT NULL,
  "kind" text NOT NULL,
  "secret_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_user_credentials_kind_check"
    CHECK ("kind" IN ('access', 'refresh'))
);
--> statement-breakpoint
CREATE INDEX "desktop_user_credentials_family_idx"
  ON "desktop_user_credentials" ("family_id", "kind");
--> statement-breakpoint
CREATE INDEX "desktop_user_credentials_user_kind_idx"
  ON "desktop_user_credentials" ("user_id", "kind");
--> statement-breakpoint
CREATE INDEX "desktop_user_credentials_expiry_idx"
  ON "desktop_user_credentials" ("expires_at");
--> statement-breakpoint

CREATE TABLE "desktop_environment_workspace_catalog" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE cascade,
  "connection_id" text NOT NULL REFERENCES "desktop_environment_connections"("id") ON DELETE cascade,
  "workspace_ref" text NOT NULL,
  "label" text NOT NULL,
  "availability" text DEFAULT 'available' NOT NULL,
  "last_seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_environment_workspace_catalog_availability_check"
    CHECK ("availability" IN ('available', 'missing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_environment_workspace_catalog_ref_idx"
  ON "desktop_environment_workspace_catalog" ("environment_id", "workspace_ref");
--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_environment_workspace_catalog_org_id_idx"
  ON "desktop_environment_workspace_catalog" ("organization_id", "id");
--> statement-breakpoint
CREATE INDEX "desktop_environment_workspace_catalog_environment_idx"
  ON "desktop_environment_workspace_catalog" ("environment_id", "availability");
--> statement-breakpoint

CREATE TABLE "desktop_environment_request_nonces" (
  "connection_id" text NOT NULL REFERENCES "desktop_environment_connections"("id") ON DELETE cascade,
  "nonce" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_environment_request_nonces_pk"
    PRIMARY KEY ("connection_id", "nonce")
);
--> statement-breakpoint
CREATE INDEX "desktop_environment_request_nonces_expiry_idx"
  ON "desktop_environment_request_nonces" ("expires_at");
--> statement-breakpoint

ALTER TABLE "environment_workspaces"
  ADD COLUMN "desktop_catalog_id" text
  REFERENCES "desktop_environment_workspace_catalog"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "environment_workspaces"
  DROP CONSTRAINT "environment_workspaces_source_type_check";
--> statement-breakpoint
ALTER TABLE "environment_workspaces"
  ADD CONSTRAINT "environment_workspaces_source_type_check"
  CHECK ("source_type" IN ('blank', 'github', 'desktop'));
--> statement-breakpoint
ALTER TABLE "environment_workspaces"
  DROP CONSTRAINT "environment_workspaces_source_check";
--> statement-breakpoint
ALTER TABLE "environment_workspaces"
  ADD CONSTRAINT "environment_workspaces_source_check" CHECK (
    (
      "source_type" = 'blank'
      AND "source_resource_id" IS NULL
      AND "source_repository" IS NULL
      AND "desktop_catalog_id" IS NULL
    )
    OR (
      "source_type" = 'github'
      AND "source_resource_id" IS NOT NULL
      AND "source_repository" IS NOT NULL
      AND "desktop_catalog_id" IS NULL
    )
    OR (
      "source_type" = 'desktop'
      AND "source_resource_id" IS NULL
      AND "source_repository" IS NULL
      AND "desktop_catalog_id" IS NOT NULL
    )
  );
--> statement-breakpoint

CREATE TABLE "desktop_environment_commands" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE cascade,
  "workspace_id" text NOT NULL REFERENCES "environment_workspaces"("id") ON DELETE restrict,
  "execution_id" text NOT NULL REFERENCES "environment_run_executions"("id") ON DELETE cascade,
  "command_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "claim_token_hash" text,
  "claim_expires_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "cancel_requested_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_environment_commands_type_check"
    CHECK ("command_type" IN ('run.start', 'run.cancel')),
  CONSTRAINT "desktop_environment_commands_status_check"
    CHECK ("status" IN ('queued', 'claimed', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_environment_commands_execution_idx"
  ON "desktop_environment_commands" ("execution_id");
--> statement-breakpoint
CREATE INDEX "desktop_environment_commands_claim_idx"
  ON "desktop_environment_commands" ("environment_id", "status", "created_at");
--> statement-breakpoint

CREATE TABLE "desktop_environment_command_events" (
  "command_id" text NOT NULL REFERENCES "desktop_environment_commands"("id") ON DELETE cascade,
  "sequence" integer NOT NULL,
  "event" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_environment_command_events_pk"
    PRIMARY KEY ("command_id", "sequence"),
  CONSTRAINT "desktop_environment_command_events_sequence_check"
    CHECK ("sequence" > 0)
);
--> statement-breakpoint

ALTER TABLE "workspace_preview_leases"
  ALTER COLUMN "thread_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_preview_leases"
  ALTER COLUMN "run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_preview_leases"
  ADD COLUMN "target_provider" text DEFAULT 'fly' NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_preview_leases"
  ADD COLUMN "desktop_connection_id" text
  REFERENCES "desktop_environment_connections"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "workspace_preview_leases"
  ADD COLUMN "desktop_tunnel_token_hash" text;
--> statement-breakpoint
ALTER TABLE "workspace_preview_leases"
  ADD COLUMN "local_run_ref" text;
--> statement-breakpoint
ALTER TABLE "workspace_preview_leases"
  ADD CONSTRAINT "workspace_preview_leases_target_check"
  CHECK (
    (
      "target_provider" = 'fly'
      AND "thread_id" IS NOT NULL
      AND "run_id" IS NOT NULL
      AND "desktop_connection_id" IS NULL
      AND "desktop_tunnel_token_hash" IS NULL
      AND "local_run_ref" IS NULL
    )
    OR
    (
      "target_provider" = 'desktop'
      AND "thread_id" IS NULL
      AND "run_id" IS NULL
      AND "desktop_connection_id" IS NOT NULL
      AND "desktop_tunnel_token_hash" IS NOT NULL
      AND "local_run_ref" IS NOT NULL
      AND "ingress_provider" = 'kestrel_edge'
    )
  );
--> statement-breakpoint

CREATE TABLE "workspace_preview_access_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "lease_id" text NOT NULL REFERENCES "workspace_preview_leases"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "secret_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workspace_preview_access_tokens_lease_idx"
  ON "workspace_preview_access_tokens" ("lease_id", "expires_at");
--> statement-breakpoint
CREATE INDEX "workspace_preview_access_tokens_user_idx"
  ON "workspace_preview_access_tokens" ("user_id");
