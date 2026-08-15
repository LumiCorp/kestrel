CREATE TABLE "environment_runtime_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_runtime_image" text NOT NULL,
  "workspace_runtime_source_revision" text NOT NULL,
  "environment_router_image" text NOT NULL,
  "environment_router_source_revision" text NOT NULL,
  "github_run_id" text,
  "github_run_attempt" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "environment_runtime_versions_digest_pair_unique"
    UNIQUE ("workspace_runtime_image", "environment_router_image"),
  CONSTRAINT "environment_runtime_versions_workspace_image_check"
    CHECK ("workspace_runtime_image" ~ '^ghcr\.io/lumicorp/kestrel-workspace-runtime@sha256:[0-9a-f]{64}$'),
  CONSTRAINT "environment_runtime_versions_router_image_check"
    CHECK ("environment_router_image" ~ '^ghcr\.io/lumicorp/kestrel-environment-router@sha256:[0-9a-f]{64}$'),
  CONSTRAINT "environment_runtime_versions_workspace_revision_check"
    CHECK ("workspace_runtime_source_revision" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "environment_runtime_versions_router_revision_check"
    CHECK ("environment_router_source_revision" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "environment_runtime_versions_run_identity_check"
    CHECK (
      ("github_run_id" IS NULL AND "github_run_attempt" IS NULL)
      OR (
        "github_run_id" ~ '^[0-9]+$'
        AND "github_run_attempt" > 0
      )
    )
);

CREATE TABLE "environment_runtime_channels" (
  "name" text PRIMARY KEY NOT NULL,
  "current_version_id" text REFERENCES "environment_runtime_versions"("id") ON DELETE RESTRICT,
  "previous_version_id" text REFERENCES "environment_runtime_versions"("id") ON DELETE RESTRICT,
  "canary_environment_id" text REFERENCES "environments"("id") ON DELETE SET NULL,
  "generation" integer DEFAULT 0 NOT NULL,
  "last_github_run_id" text,
  "last_github_run_attempt" integer,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "environment_runtime_channels_name_check"
    CHECK ("name" = 'production'),
  CONSTRAINT "environment_runtime_channels_generation_check"
    CHECK ("generation" >= 0),
  CONSTRAINT "environment_runtime_channels_distinct_versions_check"
    CHECK (
      "previous_version_id" IS NULL
      OR "current_version_id" IS NULL
      OR "previous_version_id" <> "current_version_id"
    ),
  CONSTRAINT "environment_runtime_channels_run_identity_check"
    CHECK (
      ("last_github_run_id" IS NULL AND "last_github_run_attempt" IS NULL)
      OR (
        "last_github_run_id" ~ '^[0-9]+$'
        AND "last_github_run_attempt" > 0
      )
    )
);

WITH stable_pair AS (
  SELECT
    settings."stable_release_id" AS "release_id",
    max(components."image") FILTER (
      WHERE components."role" = 'workspace-runtime'
    ) AS "workspace_runtime_image",
    max(components."source_revision") FILTER (
      WHERE components."role" = 'workspace-runtime'
    ) AS "workspace_runtime_source_revision",
    max(components."image") FILTER (
      WHERE components."role" = 'environment-router'
    ) AS "environment_router_image",
    max(components."source_revision") FILTER (
      WHERE components."role" = 'environment-router'
    ) AS "environment_router_source_revision",
    attempts."github_run_id",
    attempts."github_run_attempt"
  FROM "fly_image_release_settings" settings
  JOIN "fly_image_releases" releases
    ON releases."id" = settings."stable_release_id"
  JOIN "fly_image_release_components" components
    ON components."release_id" = releases."id"
  LEFT JOIN "fly_image_release_attempts" attempts
    ON attempts."id" = releases."attempt_id"
  WHERE settings."id" = 'platform'
  GROUP BY
    settings."stable_release_id",
    attempts."github_run_id",
    attempts."github_run_attempt"
), complete_pair AS (
  SELECT *
  FROM stable_pair
  WHERE "workspace_runtime_image" ~ '^ghcr\.io/lumicorp/kestrel-workspace-runtime@sha256:[0-9a-f]{64}$'
    AND "environment_router_image" ~ '^ghcr\.io/lumicorp/kestrel-environment-router@sha256:[0-9a-f]{64}$'
    AND "workspace_runtime_source_revision" ~ '^[0-9a-f]{40}$'
    AND "environment_router_source_revision" ~ '^[0-9a-f]{40}$'
)
INSERT INTO "environment_runtime_versions" (
  "id",
  "workspace_runtime_image",
  "workspace_runtime_source_revision",
  "environment_router_image",
  "environment_router_source_revision",
  "github_run_id",
  "github_run_attempt"
)
SELECT
  'legacy-' || "release_id",
  "workspace_runtime_image",
  "workspace_runtime_source_revision",
  "environment_router_image",
  "environment_router_source_revision",
  "github_run_id",
  "github_run_attempt"
FROM complete_pair
ON CONFLICT ("workspace_runtime_image", "environment_router_image") DO NOTHING;

INSERT INTO "environment_runtime_channels" (
  "name",
  "current_version_id",
  "previous_version_id",
  "canary_environment_id",
  "generation",
  "last_github_run_id",
  "last_github_run_attempt"
)
SELECT
  'production',
  versions."id",
  NULL,
  settings."canary_environment_id",
  CASE WHEN versions."id" IS NULL THEN 0 ELSE 1 END,
  versions."github_run_id",
  versions."github_run_attempt"
FROM (SELECT 1) singleton
LEFT JOIN "fly_image_release_settings" settings
  ON settings."id" = 'platform'
LEFT JOIN "environment_runtime_versions" versions
  ON versions."id" = 'legacy-' || settings."stable_release_id"
ON CONFLICT ("name") DO NOTHING;
