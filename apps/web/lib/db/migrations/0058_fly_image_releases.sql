CREATE TABLE IF NOT EXISTS "fly_image_releases" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bundle_revision" text NOT NULL,
  "manifest_digest" text NOT NULL,
  "trigger" text NOT NULL,
  "status" text DEFAULT 'candidate' NOT NULL,
  "migration_changed" boolean DEFAULT false NOT NULL,
  "migration_approved_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "migration_approved_at" timestamp with time zone,
  "validation" jsonb NOT NULL,
  "base_release_id" text,
  "approved_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "approved_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fly_image_releases_manifest_digest_unique" UNIQUE("manifest_digest"),
  CONSTRAINT "fly_image_releases_trigger_check" CHECK ("trigger" IN ('main', 'scheduled', 'manual', 'bootstrap', 'rollback')),
  CONSTRAINT "fly_image_releases_status_check" CHECK ("status" IN ('candidate', 'approved', 'deploying', 'paused', 'completed', 'superseded')),
  CONSTRAINT "fly_image_releases_bundle_revision_check" CHECK ("bundle_revision" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "fly_image_releases_manifest_digest_check" CHECK ("manifest_digest" ~ '^sha256:[0-9a-f]{64}$')
);

ALTER TABLE "fly_image_releases"
  ADD CONSTRAINT "fly_image_releases_base_release_fk"
  FOREIGN KEY ("base_release_id") REFERENCES "fly_image_releases"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "fly_image_releases_status_created_idx"
  ON "fly_image_releases" ("status", "created_at");

CREATE TABLE IF NOT EXISTS "fly_image_release_components" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "release_id" text NOT NULL REFERENCES "fly_image_releases"("id") ON DELETE cascade,
  "role" text NOT NULL,
  "image" text NOT NULL,
  "source_revision" text NOT NULL,
  "input_fingerprint" text NOT NULL,
  "changed" boolean NOT NULL,
  "smoke" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fly_image_release_components_release_role_unique" UNIQUE("release_id", "role"),
  CONSTRAINT "fly_image_release_components_role_check" CHECK ("role" IN ('workspace-runtime', 'environment-router', 'preview-edge', 'turn-worker', 'runpod-worker')),
  CONSTRAINT "fly_image_release_components_image_check" CHECK ("image" ~ '^registry\.fly\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$'),
  CONSTRAINT "fly_image_release_components_revision_check" CHECK ("source_revision" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "fly_image_release_components_fingerprint_check" CHECK ("input_fingerprint" ~ '^sha256:[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS "fly_image_release_targets" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "release_id" text NOT NULL REFERENCES "fly_image_releases"("id") ON DELETE cascade,
  "target_kind" text NOT NULL,
  "component_role" text,
  "environment_id" text REFERENCES "environments"("id") ON DELETE set null,
  "workspace_id" text REFERENCES "environment_workspaces"("id") ON DELETE set null,
  "target_key" text NOT NULL,
  "desired_image" text,
  "prior_image" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "stage" text DEFAULT 'pending' NOT NULL,
  "result" jsonb,
  "failure_code" text,
  "failure_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fly_image_release_targets_release_key_unique" UNIQUE("release_id", "target_key"),
  CONSTRAINT "fly_image_release_targets_kind_check" CHECK ("target_kind" IN ('global_app', 'environment', 'workspace')),
  CONSTRAINT "fly_image_release_targets_role_check" CHECK ("component_role" IS NULL OR "component_role" IN ('workspace-runtime', 'environment-router', 'preview-edge', 'turn-worker', 'runpod-worker')),
  CONSTRAINT "fly_image_release_targets_status_check" CHECK ("status" IN ('pending', 'draining', 'applying', 'configured_unverified', 'verifying', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS "fly_image_release_targets_release_status_idx"
  ON "fly_image_release_targets" ("release_id", "status");
CREATE INDEX IF NOT EXISTS "fly_image_release_targets_environment_idx"
  ON "fly_image_release_targets" ("environment_id");

CREATE TABLE IF NOT EXISTS "fly_image_release_settings" (
  "id" text PRIMARY KEY DEFAULT 'platform' NOT NULL,
  "stable_release_id" text REFERENCES "fly_image_releases"("id") ON DELETE set null,
  "active_release_id" text REFERENCES "fly_image_releases"("id") ON DELETE set null,
  "canary_environment_id" text REFERENCES "environments"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fly_image_release_settings_singleton_check" CHECK ("id" = 'platform')
);

INSERT INTO "fly_image_release_settings" ("id") VALUES ('platform')
ON CONFLICT ("id") DO NOTHING;
