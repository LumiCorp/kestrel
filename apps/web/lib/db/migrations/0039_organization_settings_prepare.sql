ALTER TABLE "ai_provider_connections"
  ADD COLUMN IF NOT EXISTS "organization_id" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "ai_provider_connections_provider_scope_idx";
--> statement-breakpoint
ALTER TABLE "ai_provider_connections"
  DROP CONSTRAINT IF EXISTS "ai_provider_connections_scope_check";
--> statement-breakpoint
UPDATE "ai_provider_connections"
SET "scope" = 'organization'
WHERE "scope" <> 'organization';
--> statement-breakpoint
ALTER TABLE "ai_provider_connections"
  ALTER COLUMN "scope" SET DEFAULT 'organization';
--> statement-breakpoint
ALTER TABLE "ai_provider_connections"
  ADD CONSTRAINT "ai_provider_connections_scope_check"
  CHECK ("scope" = 'organization');
--> statement-breakpoint
ALTER TABLE "ai_provider_connections"
  ADD CONSTRAINT "ai_provider_connections_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_connections_organization_provider_idx"
  ON "ai_provider_connections" ("organization_id", "provider")
  WHERE "organization_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_provider_connections_organization_idx"
  ON "ai_provider_connections" ("organization_id");
--> statement-breakpoint

ALTER TABLE "ai_deployment_profiles"
  ADD COLUMN IF NOT EXISTS "organization_id" text;
--> statement-breakpoint
ALTER TABLE "ai_deployment_profiles"
  ADD CONSTRAINT "ai_deployment_profiles_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
DROP INDEX IF EXISTS "ai_deployment_profiles_key_version_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "ai_deployment_profiles_spec_hash_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "ai_deployment_profiles_status_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_deployment_profiles_key_version_idx"
  ON "ai_deployment_profiles" ("organization_id", "profile_key", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_deployment_profiles_spec_hash_idx"
  ON "ai_deployment_profiles" ("organization_id", "spec_hash");
--> statement-breakpoint
CREATE INDEX "ai_deployment_profiles_status_idx"
  ON "ai_deployment_profiles" ("organization_id", "status");
--> statement-breakpoint

ALTER TABLE "ai_gateway_models"
  ADD COLUMN IF NOT EXISTS "organization_id" text;
--> statement-breakpoint
ALTER TABLE "ai_gateway_models"
  ADD CONSTRAINT "ai_gateway_models_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
UPDATE "ai_gateway_models" AS model
SET "organization_id" = gateway."organization_id"
FROM "ai_gateways" AS gateway
WHERE model."gateway_id" = gateway."id"
  AND model."organization_id" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "ai_gateway_models_alias_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_gateway_models_alias_idx"
  ON "ai_gateway_models" ("organization_id", "alias");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_connections_organization_id_id_idx"
  ON "ai_provider_connections" ("organization_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_deployment_profiles_organization_id_id_idx"
  ON "ai_deployment_profiles" ("organization_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_gateways_organization_id_id_idx"
  ON "ai_gateways" ("organization_id", "id");
--> statement-breakpoint
ALTER TABLE "ai_gateways"
  ADD CONSTRAINT "ai_gateways_organization_provider_connection_fk"
  FOREIGN KEY ("organization_id", "provider_connection_id")
  REFERENCES "ai_provider_connections" ("organization_id", "id")
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "ai_gateway_models"
  ADD CONSTRAINT "ai_gateway_models_organization_gateway_fk"
  FOREIGN KEY ("organization_id", "gateway_id")
  REFERENCES "ai_gateways" ("organization_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "ai_deployments"
  ADD CONSTRAINT "ai_deployments_organization_profile_fk"
  FOREIGN KEY ("organization_id", "profile_id")
  REFERENCES "ai_deployment_profiles" ("organization_id", "id")
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

ALTER TABLE "app_connections"
  DROP CONSTRAINT IF EXISTS "app_connections_owner_scope_check";
--> statement-breakpoint
ALTER TABLE "app_connections"
  ADD CONSTRAINT "app_connections_owner_scope_check" CHECK (
    ("owner_type" = 'system' AND "environment_id" IS NULL AND "user_id" IS NULL AND "credential_id" IS NULL)
    OR
    ("owner_type" = 'organization' AND "environment_id" IS NULL AND "user_id" IS NULL AND "credential_id" IS NULL)
    OR
    ("owner_type" = 'personal' AND "user_id" IS NOT NULL AND "environment_id" IS NULL AND "credential_id" IS NULL)
    OR
    ("owner_type" IN ('environment', 'deployment_managed') AND "environment_id" IS NOT NULL AND "user_id" IS NULL)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_connections_organization_name_idx"
  ON "app_connections" ("organization_id", "app_key", "name")
  WHERE "owner_type" = 'organization';
--> statement-breakpoint
ALTER TABLE "app_definitions"
  DROP CONSTRAINT IF EXISTS "app_definitions_connection_model_check";
--> statement-breakpoint
ALTER TABLE "app_definitions"
  ADD CONSTRAINT "app_definitions_connection_model_check"
  CHECK ("connection_model" IN ('none', 'organization', 'personal', 'environment', 'hybrid'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization_email_config" (
  "organization_id" text PRIMARY KEY NOT NULL,
  "provider" text DEFAULT 'resend' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "encrypted_api_key" text,
  "from_name" text NOT NULL,
  "from_email" text NOT NULL,
  "reply_to" text,
  "last_tested_at" timestamp with time zone,
  "last_test_message_id" text,
  "last_test_config_fingerprint" text,
  "last_error_code" text,
  "updated_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_email_config_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "organization_email_config_updated_by_user_id_user_id_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization_infrastructure_settings" (
  "organization_id" text PRIMARY KEY NOT NULL,
  "allowed_regions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "default_region" text,
  "allowed_runtime_templates" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "default_runtime_template" text,
  "updated_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_infrastructure_settings_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "organization_infrastructure_settings_updated_by_user_id_user_id_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization_email_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" text,
  "thread_id" text,
  "actor_user_id" text,
  "approval_id" text,
  "status" text NOT NULL,
  "provider_message_id" text,
  "recipient_count" integer NOT NULL,
  "recipient_domains" jsonb NOT NULL,
  "subject_hash" text NOT NULL,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_email_deliveries_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "organization_email_deliveries_project_id_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL,
  CONSTRAINT "organization_email_deliveries_thread_id_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE SET NULL,
  CONSTRAINT "organization_email_deliveries_actor_user_id_user_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL,
  CONSTRAINT "organization_email_deliveries_approval_id_app_operation_approvals_id_fk"
    FOREIGN KEY ("approval_id") REFERENCES "app_operation_approvals"("id") ON DELETE SET NULL,
  CONSTRAINT "organization_email_deliveries_status_check"
    CHECK ("status" IN ('accepted', 'rejected', 'failed')),
  CONSTRAINT "organization_email_deliveries_recipient_count_check"
    CHECK ("recipient_count" > 0 AND "recipient_count" <= 20)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_email_deliveries_org_created_idx"
  ON "organization_email_deliveries" ("organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_email_deliveries_project_idx"
  ON "organization_email_deliveries" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_email_deliveries_approval_idx"
  ON "organization_email_deliveries" ("approval_id");
