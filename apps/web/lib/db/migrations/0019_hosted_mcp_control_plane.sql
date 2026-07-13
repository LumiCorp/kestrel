CREATE TABLE "mcp_credentials" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"created_by_user_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_credentials_kind_check" CHECK ("kind" IN ('oauth', 'secret_headers')),
	CONSTRAINT "mcp_credentials_status_check" CHECK ("status" IN ('active', 'refresh_required', 'revoked')),
	CONSTRAINT "mcp_credentials_encrypted_payload_check" CHECK ("encrypted_payload" LIKE 'kmcp:v1:%')
);
--> statement-breakpoint
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_organization_environment_fk" FOREIGN KEY ("organization_id", "environment_id") REFERENCES "public"."environments"("organization_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_credentials_environment_id_idx" ON "mcp_credentials" USING btree ("environment_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_credentials_environment_name_idx" ON "mcp_credentials" USING btree ("environment_id", "name");
--> statement-breakpoint
CREATE INDEX "mcp_credentials_environment_status_idx" ON "mcp_credentials" USING btree ("environment_id", "status");
--> statement-breakpoint

CREATE TABLE "mcp_oauth_authorizations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"credential_name" text NOT NULL,
	"state_digest" text NOT NULL,
	"encrypted_session" text NOT NULL,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"client_id" text NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource" text,
	"redirect_uri" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_authorizations_auth_method_check" CHECK ("token_endpoint_auth_method" IN ('none', 'client_secret_basic', 'client_secret_post')),
	CONSTRAINT "mcp_oauth_authorizations_status_check" CHECK ("status" IN ('pending', 'completed', 'failed', 'expired')),
	CONSTRAINT "mcp_oauth_authorizations_encrypted_session_check" CHECK ("encrypted_session" LIKE 'kmcp:v1:%')
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_organization_environment_fk" FOREIGN KEY ("organization_id", "environment_id") REFERENCES "public"."environments"("organization_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_authorizations_state_digest_idx" ON "mcp_oauth_authorizations" USING btree ("state_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_authorizations_credential_id_idx" ON "mcp_oauth_authorizations" USING btree ("credential_id");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorizations_expiry_status_idx" ON "mcp_oauth_authorizations" USING btree ("expires_at", "status");
--> statement-breakpoint

CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"credential_id" text,
	"created_by_user_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"source_type" text NOT NULL,
	"transport" text NOT NULL,
	"remote_url" text,
	"oci_image_reference" text,
	"oci_digest" text,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"launch_arguments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"egress_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cpu_millicores" integer DEFAULT 500 NOT NULL,
	"memory_mib" integer DEFAULT 512 NOT NULL,
	"pids_limit" integer DEFAULT 128 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"last_health_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_source_type_check" CHECK ("source_type" IN ('remote', 'oci')),
	CONSTRAINT "mcp_servers_transport_check" CHECK ("transport" IN ('streamable_http', 'stdio')),
	CONSTRAINT "mcp_servers_auth_mode_check" CHECK ("auth_mode" IN ('none', 'oauth', 'secret_headers')),
	CONSTRAINT "mcp_servers_status_check" CHECK ("status" IN ('draft', 'discovering', 'ready', 'degraded', 'disabled')),
	CONSTRAINT "mcp_servers_source_check" CHECK (
		("source_type" = 'remote' AND "transport" = 'streamable_http' AND "remote_url" IS NOT NULL AND "oci_image_reference" IS NULL AND "oci_digest" IS NULL)
		OR
		("source_type" = 'oci' AND "remote_url" IS NULL AND "oci_image_reference" IS NOT NULL AND "oci_digest" ~ '^sha256:[0-9a-f]{64}$' AND "oci_image_reference" LIKE '%@sha256:%')
	),
	CONSTRAINT "mcp_servers_auth_check" CHECK (
		("auth_mode" = 'none' AND "credential_id" IS NULL)
		OR
		("auth_mode" <> 'none' AND "credential_id" IS NOT NULL)
	),
	CONSTRAINT "mcp_servers_resource_limits_check" CHECK ("cpu_millicores" > 0 AND "memory_mib" > 0 AND "pids_limit" > 0)
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_provider_key_tool_providers_key_fk" FOREIGN KEY ("provider_key") REFERENCES "public"."tool_providers"("key") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_organization_environment_fk" FOREIGN KEY ("organization_id", "environment_id") REFERENCES "public"."environments"("organization_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_environment_credential_fk" FOREIGN KEY ("environment_id", "credential_id") REFERENCES "public"."mcp_credentials"("environment_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_environment_slug_idx" ON "mcp_servers" USING btree ("environment_id", "slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_provider_key_idx" ON "mcp_servers" USING btree ("provider_key");
--> statement-breakpoint
CREATE INDEX "mcp_servers_environment_status_idx" ON "mcp_servers" USING btree ("environment_id", "status");
--> statement-breakpoint

CREATE TABLE "mcp_capability_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" text NOT NULL,
	"protocol_version" text NOT NULL,
	"capability_digest" text NOT NULL,
	"server_info" jsonb,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_capability_snapshots_status_check" CHECK ("status" IN ('pending_review', 'approved', 'rejected', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "mcp_capability_snapshots" ADD CONSTRAINT "mcp_capability_snapshots_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_capability_snapshots" ADD CONSTRAINT "mcp_capability_snapshots_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_capability_snapshots_server_digest_idx" ON "mcp_capability_snapshots" USING btree ("server_id", "capability_digest");
--> statement-breakpoint
CREATE INDEX "mcp_capability_snapshots_server_status_idx" ON "mcp_capability_snapshots" USING btree ("server_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_capability_snapshots_approved_server_idx" ON "mcp_capability_snapshots" USING btree ("server_id") WHERE "status" = 'approved';
--> statement-breakpoint

CREATE TABLE "mcp_discovery_jobs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"server_id" text NOT NULL,
	"requested_by_user_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_discovery_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "mcp_discovery_jobs" ADD CONSTRAINT "mcp_discovery_jobs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_discovery_jobs" ADD CONSTRAINT "mcp_discovery_jobs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_discovery_jobs" ADD CONSTRAINT "mcp_discovery_jobs_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_discovery_jobs" ADD CONSTRAINT "mcp_discovery_jobs_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_discovery_jobs" ADD CONSTRAINT "mcp_discovery_jobs_organization_environment_fk" FOREIGN KEY ("organization_id", "environment_id") REFERENCES "public"."environments"("organization_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_discovery_jobs_active_server_idx" ON "mcp_discovery_jobs" USING btree ("server_id") WHERE "status" IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX "mcp_discovery_jobs_status_created_idx" ON "mcp_discovery_jobs" USING btree ("status", "created_at");
--> statement-breakpoint

CREATE TABLE "mcp_capabilities" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"tool_capability_key" text,
	"kind" text NOT NULL,
	"capability_key" text NOT NULL,
	"display_name" text,
	"description" text,
	"definition" jsonb NOT NULL,
	"environment_enabled" boolean DEFAULT false NOT NULL,
	"approval_mode" text DEFAULT 'deny' NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_capabilities_kind_check" CHECK ("kind" IN ('tool', 'resource', 'resource_template', 'prompt', 'root', 'sampling', 'elicitation', 'completion', 'logging', 'task')),
	CONSTRAINT "mcp_capabilities_approval_mode_check" CHECK ("approval_mode" IN ('auto', 'ask', 'deny')),
	CONSTRAINT "mcp_capabilities_tool_projection_check" CHECK (
		("kind" = 'tool' AND "tool_capability_key" IS NOT NULL)
		OR
		("kind" <> 'tool' AND "tool_capability_key" IS NULL)
	)
);
--> statement-breakpoint
ALTER TABLE "mcp_capabilities" ADD CONSTRAINT "mcp_capabilities_snapshot_id_mcp_capability_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."mcp_capability_snapshots"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_capabilities" ADD CONSTRAINT "mcp_capabilities_provider_key_tool_providers_key_fk" FOREIGN KEY ("provider_key") REFERENCES "public"."tool_providers"("key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_capabilities" ADD CONSTRAINT "mcp_capabilities_tool_capability_fk" FOREIGN KEY ("provider_key", "tool_capability_key") REFERENCES "public"."tool_capabilities"("provider_key", "key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_capabilities" ADD CONSTRAINT "mcp_capabilities_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_capabilities_snapshot_kind_key_idx" ON "mcp_capabilities" USING btree ("snapshot_id", "kind", "capability_key");
--> statement-breakpoint
CREATE INDEX "mcp_capabilities_provider_enabled_idx" ON "mcp_capabilities" USING btree ("provider_key", "environment_enabled");
--> statement-breakpoint

CREATE TABLE "mcp_project_capability_restrictions" (
	"project_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"approval_mode" text DEFAULT 'deny' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_project_capability_restrictions_project_id_capability_id_pk" PRIMARY KEY("project_id", "capability_id"),
	CONSTRAINT "mcp_project_capability_restrictions_approval_mode_check" CHECK ("approval_mode" IN ('auto', 'ask', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "mcp_project_capability_restrictions" ADD CONSTRAINT "mcp_project_capability_restrictions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_project_capability_restrictions" ADD CONSTRAINT "mcp_project_capability_restrictions_capability_id_mcp_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."mcp_capabilities"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mcp_project_capability_restrictions_capability_idx" ON "mcp_project_capability_restrictions" USING btree ("capability_id");
--> statement-breakpoint

CREATE TABLE "mcp_project_resource_references" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"server_id" text NOT NULL,
	"resource_uri" text NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_project_resource_references" ADD CONSTRAINT "mcp_project_resource_references_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_project_resource_references" ADD CONSTRAINT "mcp_project_resource_references_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_project_resource_references" ADD CONSTRAINT "mcp_project_resource_references_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_project_resource_references_uri_idx" ON "mcp_project_resource_references" USING btree ("project_id", "server_id", "resource_uri");
--> statement-breakpoint
CREATE INDEX "mcp_project_resource_references_server_idx" ON "mcp_project_resource_references" USING btree ("server_id");
--> statement-breakpoint

CREATE TABLE "mcp_run_grants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_execution_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"project_id" text,
	"thread_id" text NOT NULL,
	"policy_digest" text NOT NULL,
	"effective_capabilities" jsonb NOT NULL,
	"effective_policy" jsonb NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_run_grants_status_check" CHECK ("status" IN ('issued', 'active', 'revoked', 'expired')),
	CONSTRAINT "mcp_run_grants_expiry_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_run_execution_id_environment_run_executions_id_fk" FOREIGN KEY ("run_execution_id") REFERENCES "public"."environment_run_executions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_organization_environment_fk" FOREIGN KEY ("organization_id", "environment_id") REFERENCES "public"."environments"("organization_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_run_grants_run_execution_idx" ON "mcp_run_grants" USING btree ("run_execution_id");
--> statement-breakpoint
CREATE INDEX "mcp_run_grants_expiry_status_idx" ON "mcp_run_grants" USING btree ("expires_at", "status");
--> statement-breakpoint

CREATE TABLE "mcp_invocations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" text NOT NULL,
	"server_id" text NOT NULL,
	"capability_id" text,
	"request_id" text NOT NULL,
	"method" text NOT NULL,
	"request_digest" text NOT NULL,
	"response_digest" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"replay_evidence" jsonb,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_invocations_status_check" CHECK ("status" IN ('requested', 'waiting_approval', 'waiting_sampling', 'waiting_elicitation', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "mcp_invocations" ADD CONSTRAINT "mcp_invocations_grant_id_mcp_run_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_run_grants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_invocations" ADD CONSTRAINT "mcp_invocations_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_invocations" ADD CONSTRAINT "mcp_invocations_capability_id_mcp_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."mcp_capabilities"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_invocations_grant_request_idx" ON "mcp_invocations" USING btree ("grant_id", "request_id");
--> statement-breakpoint
CREATE INDEX "mcp_invocations_server_created_idx" ON "mcp_invocations" USING btree ("server_id", "created_at");
--> statement-breakpoint
CREATE INDEX "mcp_invocations_status_created_idx" ON "mcp_invocations" USING btree ("status", "created_at");
--> statement-breakpoint

CREATE TABLE "mcp_interaction_checkpoints" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invocation_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"request_envelope" jsonb NOT NULL,
	"response_envelope" jsonb,
	"replay_cursor" jsonb NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_interaction_checkpoints_kind_check" CHECK ("kind" IN ('sampling', 'elicitation')),
	CONSTRAINT "mcp_interaction_checkpoints_status_check" CHECK ("status" IN ('requested', 'approved', 'denied', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "mcp_interaction_checkpoints" ADD CONSTRAINT "mcp_interaction_checkpoints_invocation_id_mcp_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."mcp_invocations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_interaction_checkpoints" ADD CONSTRAINT "mcp_interaction_checkpoints_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mcp_interaction_checkpoints" ADD CONSTRAINT "mcp_interaction_checkpoints_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_interaction_checkpoints_invocation_idx" ON "mcp_interaction_checkpoints" USING btree ("invocation_id");
--> statement-breakpoint
CREATE INDEX "mcp_interaction_checkpoints_thread_status_idx" ON "mcp_interaction_checkpoints" USING btree ("thread_id", "status");
