ALTER TABLE "environments"
  ADD COLUMN IF NOT EXISTS "target_router_image" text,
  ADD COLUMN IF NOT EXISTS "target_runtime_image" text,
  ADD COLUMN IF NOT EXISTS "target_source_revision" text,
  ADD COLUMN IF NOT EXISTS "target_generation" integer;
--> statement-breakpoint
ALTER TABLE "environments"
  ADD CONSTRAINT "environments_target_generation_check"
  CHECK ("target_generation" IS NULL OR "target_generation" >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "environments"
  ADD CONSTRAINT "environments_target_source_revision_check"
  CHECK ("target_source_revision" IS NULL OR "target_source_revision" ~ '^[0-9a-f]{40}$') NOT VALID;
--> statement-breakpoint
CREATE TABLE "platform_runtime_settings" (
  "id" text PRIMARY KEY DEFAULT 'platform' NOT NULL,
  "generation" integer DEFAULT 0 NOT NULL,
  "desired_source_revision" text,
  "active_source_revision" text,
  "prior_source_revision" text,
  "desired_router_image" text,
  "active_router_image" text,
  "prior_router_image" text,
  "desired_runtime_image" text,
  "active_runtime_image" text,
  "prior_runtime_image" text,
  "canary_environment_id" text REFERENCES "environments"("id") ON DELETE SET NULL,
  "mode" text DEFAULT 'rolling' NOT NULL,
  "status" text DEFAULT 'ready' NOT NULL,
  "workspace_data_migration_revision" text,
  "last_failure_code" text,
  "last_failure_message" text,
  "last_failure_at" timestamp with time zone,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_runtime_settings_singleton_check" CHECK ("id" = 'platform'),
  CONSTRAINT "platform_runtime_settings_generation_check" CHECK ("generation" >= 0),
  CONSTRAINT "platform_runtime_settings_mode_check" CHECK ("mode" IN ('rolling', 'maintenance')),
  CONSTRAINT "platform_runtime_settings_status_check" CHECK (
    "status" IN ('ready', 'canary', 'fanout', 'degraded', 'blocked', 'rejected', 'maintenance_pending', 'maintenance')
  ),
  CONSTRAINT "platform_runtime_settings_source_revision_check" CHECK (
    ("desired_source_revision" IS NULL OR "desired_source_revision" ~ '^[0-9a-f]{40}$') AND
    ("active_source_revision" IS NULL OR "active_source_revision" ~ '^[0-9a-f]{40}$') AND
    ("prior_source_revision" IS NULL OR "prior_source_revision" ~ '^[0-9a-f]{40}$')
  ),
  CONSTRAINT "platform_runtime_settings_image_check" CHECK (
    ("desired_router_image" IS NULL OR "desired_router_image" ~ '^registry\.fly\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$') AND
    ("active_router_image" IS NULL OR "active_router_image" ~ '^registry\.fly\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$') AND
    ("prior_router_image" IS NULL OR "prior_router_image" ~ '^registry\.fly\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$') AND
    ("desired_runtime_image" IS NULL OR "desired_runtime_image" ~ '^registry\.fly\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$') AND
    ("active_runtime_image" IS NULL OR "active_runtime_image" ~ '^registry\.fly\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$') AND
    ("prior_runtime_image" IS NULL OR "prior_runtime_image" ~ '^registry\.fly\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$')
  ),
  CONSTRAINT "platform_runtime_settings_migration_mode_check" CHECK (
    "workspace_data_migration_revision" IS NULL OR "mode" = 'maintenance'
  )
);
--> statement-breakpoint
INSERT INTO "platform_runtime_settings" (
  "id",
  "desired_source_revision",
  "active_source_revision",
  "prior_source_revision",
  "desired_router_image",
  "active_router_image",
  "prior_router_image",
  "desired_runtime_image",
  "active_runtime_image",
  "prior_runtime_image",
  "canary_environment_id",
  "status",
  "last_failure_code",
  "last_failure_message"
)
SELECT
  'platform',
  stable."bundle_revision",
  stable."bundle_revision",
  stable."bundle_revision",
  router."image",
  router."image",
  router."image",
  runtime."image",
  runtime."image",
  runtime."image",
  settings."canary_environment_id",
  CASE WHEN router."image" IS NOT NULL AND runtime."image" IS NOT NULL
    THEN 'ready' ELSE 'blocked' END,
  CASE WHEN router."image" IS NULL OR runtime."image" IS NULL
    THEN 'PLATFORM_RUNTIME_BACKFILL_INCOMPLETE' ELSE NULL END,
  CASE WHEN router."image" IS NULL OR runtime."image" IS NULL
    THEN 'No stable router and Workspace Runtime release was available during backfill.' ELSE NULL END
FROM "fly_image_release_settings" AS settings
LEFT JOIN "fly_image_releases" AS stable
  ON stable."id" = settings."stable_release_id"
LEFT JOIN "fly_image_release_components" AS router
  ON router."release_id" = stable."id" AND router."role" = 'environment-router'
LEFT JOIN "fly_image_release_components" AS runtime
  ON runtime."release_id" = stable."id" AND runtime."role" = 'workspace-runtime'
WHERE settings."id" = 'platform'
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "platform_runtime_settings" (
  "id", "status", "last_failure_code", "last_failure_message"
)
VALUES (
  'platform', 'blocked', 'PLATFORM_RUNTIME_BACKFILL_INCOMPLETE',
  'Legacy release settings were unavailable during backfill.'
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "environments"
SET
  "target_router_image" = "router_image",
  "target_runtime_image" = "runtime_image",
  "target_source_revision" = (
    SELECT "active_source_revision"
    FROM "platform_runtime_settings"
    WHERE "id" = 'platform'
  ),
  "target_generation" = 0,
  "updated_at" = now()
WHERE "provider" = 'fly' AND "archived_at" IS NULL;
