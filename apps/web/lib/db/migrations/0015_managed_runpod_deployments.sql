CREATE TABLE IF NOT EXISTS "ai_provider_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "scope" text DEFAULT 'platform' NOT NULL,
  "display_name" text NOT NULL,
  "api_key_env_var" text,
  "api_key" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "status" text DEFAULT 'not_configured' NOT NULL,
  "last_tested_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_provider_connections_provider_check" CHECK ("provider" = 'runpod'),
  CONSTRAINT "ai_provider_connections_scope_check" CHECK ("scope" = 'platform'),
  CONSTRAINT "ai_provider_connections_status_check" CHECK ("status" IN ('not_configured', 'ready', 'degraded'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_connections_provider_scope_idx"
  ON "ai_provider_connections" ("provider", "scope");

CREATE TABLE IF NOT EXISTS "ai_deployment_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "profile_key" text NOT NULL,
  "version" integer NOT NULL,
  "display_name" text NOT NULL,
  "description" text,
  "provider" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "image_ref" text NOT NULL,
  "expected_model_id" text NOT NULL,
  "spec_hash" text NOT NULL,
  "template_spec" jsonb NOT NULL,
  "endpoint_spec" jsonb NOT NULL,
  "cost_limit_usd_per_hour" real NOT NULL,
  "qualification_evidence" jsonb,
  "qualified_at" timestamp with time zone,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "activated_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_deployment_profiles_provider_check" CHECK ("provider" = 'runpod'),
  CONSTRAINT "ai_deployment_profiles_status_check" CHECK ("status" IN ('draft', 'qualifying', 'active', 'deprecated')),
  CONSTRAINT "ai_deployment_profiles_version_check" CHECK ("version" > 0),
  CONSTRAINT "ai_deployment_profiles_cost_check" CHECK ("cost_limit_usd_per_hour" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_deployment_profiles_key_version_idx"
  ON "ai_deployment_profiles" ("profile_key", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "ai_deployment_profiles_spec_hash_idx"
  ON "ai_deployment_profiles" ("spec_hash");
CREATE INDEX IF NOT EXISTS "ai_deployment_profiles_status_idx"
  ON "ai_deployment_profiles" ("status");

CREATE TABLE IF NOT EXISTS "organization_ai_deployment_policies" (
  "organization_id" text PRIMARY KEY NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "enabled" boolean DEFAULT false NOT NULL,
  "max_active_deployments" integer DEFAULT 0 NOT NULL,
  "updated_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_ai_deployment_policy_quota_check" CHECK ("max_active_deployments" >= 0)
);

CREATE TABLE IF NOT EXISTS "organization_ai_deployment_entitlements" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "granted_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("organization_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "organization_ai_deployment_entitlements_user_idx"
  ON "organization_ai_deployment_entitlements" ("user_id");

ALTER TABLE "ai_gateways" ADD COLUMN IF NOT EXISTS "organization_id" text REFERENCES "organization"("id") ON DELETE cascade;
ALTER TABLE "ai_gateways" ADD COLUMN IF NOT EXISTS "deployment_id" text;
ALTER TABLE "ai_gateways" ADD COLUMN IF NOT EXISTS "provider_connection_id" text REFERENCES "ai_provider_connections"("id") ON DELETE restrict;

DROP INDEX IF EXISTS "ai_gateways_provider_display_name_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "ai_gateways_deployment_id_idx"
  ON "ai_gateways" ("deployment_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ai_gateways_global_provider_display_name_idx"
  ON "ai_gateways" ("provider", "display_name") WHERE "organization_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ai_gateways_org_provider_display_name_idx"
  ON "ai_gateways" ("organization_id", "provider", "display_name") WHERE "organization_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ai_gateways_org_id_idx"
  ON "ai_gateways" ("organization_id");

CREATE TABLE IF NOT EXISTS "ai_deployments" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE restrict,
  "profile_id" text NOT NULL REFERENCES "ai_deployment_profiles"("id") ON DELETE restrict,
  "display_name" text NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "provider_template_id" text,
  "provider_endpoint_id" text,
  "gateway_id" text REFERENCES "ai_gateways"("id") ON DELETE set null,
  "spec_snapshot" jsonb NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "reconciliation_deadline" timestamp with time zone,
  "last_reconciled_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_deployments_status_check" CHECK ("status" IN ('requested', 'provisioning_template', 'provisioning_endpoint', 'waiting_for_capacity', 'validating', 'ready', 'failed', 'deleting', 'delete_failed', 'deleted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_deployments_active_org_profile_idx"
  ON "ai_deployments" ("organization_id", "profile_id") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ai_deployments_provider_endpoint_idx"
  ON "ai_deployments" ("provider_endpoint_id");
CREATE INDEX IF NOT EXISTS "ai_deployments_org_id_idx" ON "ai_deployments" ("organization_id");
CREATE INDEX IF NOT EXISTS "ai_deployments_status_idx" ON "ai_deployments" ("status");

CREATE TABLE IF NOT EXISTS "ai_deployment_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "profile_id" text NOT NULL REFERENCES "ai_deployment_profiles"("id") ON DELETE restrict,
  "deployment_id" text REFERENCES "ai_deployments"("id") ON DELETE cascade,
  "status" text DEFAULT 'queued' NOT NULL,
  "provider_template_id" text,
  "provider_endpoint_id" text,
  "attempt" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "error_message" text,
  "metadata" jsonb,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_deployment_runs_kind_check" CHECK ("kind" IN ('qualification', 'provision', 'reconcile', 'delete', 'usage')),
  CONSTRAINT "ai_deployment_runs_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS "ai_deployment_runs_deployment_idx" ON "ai_deployment_runs" ("deployment_id");
CREATE INDEX IF NOT EXISTS "ai_deployment_runs_profile_idx" ON "ai_deployment_runs" ("profile_id");
CREATE INDEX IF NOT EXISTS "ai_deployment_runs_status_idx" ON "ai_deployment_runs" ("status");

CREATE TABLE IF NOT EXISTS "ai_deployment_usage" (
  "id" text PRIMARY KEY NOT NULL,
  "deployment_id" text NOT NULL REFERENCES "ai_deployments"("id") ON DELETE cascade,
  "provider_endpoint_id" text NOT NULL,
  "bucket_started_at" timestamp with time zone NOT NULL,
  "amount_usd" real NOT NULL,
  "time_billed_ms" integer DEFAULT 0 NOT NULL,
  "disk_space_billed_gb" integer DEFAULT 0 NOT NULL,
  "gpu_type_id" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "ai_deployment_usage"
  ADD CONSTRAINT "ai_deployment_usage_bucket_idx"
  UNIQUE NULLS NOT DISTINCT ("deployment_id", "bucket_started_at", "gpu_type_id");
CREATE INDEX IF NOT EXISTS "ai_deployment_usage_endpoint_idx"
  ON "ai_deployment_usage" ("provider_endpoint_id");
