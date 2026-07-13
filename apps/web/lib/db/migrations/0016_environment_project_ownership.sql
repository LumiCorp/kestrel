ALTER TABLE "environments"
  ALTER COLUMN "created_by_user_id" DROP NOT NULL;
ALTER TABLE "environments"
  DROP CONSTRAINT IF EXISTS "environments_created_by_user_id_fkey";
ALTER TABLE "environments"
  ADD CONSTRAINT "environments_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id")
  ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "environments_org_id_idx"
  ON "environments" ("organization_id", "id");

-- Preserve an existing active Environment when an organization already has
-- one but no default has been selected yet.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "organization_id"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS rank
  FROM "environments" candidate
  WHERE "archived_at" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "environments" current_default
      WHERE current_default."organization_id" = candidate."organization_id"
        AND current_default."is_default" = true
        AND current_default."archived_at" IS NULL
    )
)
UPDATE "environments" environment
SET "is_default" = true, "updated_at" = now()
FROM ranked
WHERE ranked.rank = 1
  AND ranked."id" = environment."id";

-- Organizations created before hosted Environments receive a deterministic
-- product default. The creator is attribution only, so system backfills may
-- leave it null when legacy organization data has no remaining member.
WITH organization_creators AS (
  SELECT DISTINCT ON (member."organizationId")
    member."organizationId" AS organization_id,
    member."userId" AS user_id
  FROM "member" member
  ORDER BY
    member."organizationId",
    CASE
      WHEN member."role" = 'owner' THEN 0
      WHEN member."role" = 'admin' THEN 1
      ELSE 2
    END,
    member."createdAt" ASC,
    member."id" ASC
)
INSERT INTO "environments" (
  "id",
  "organization_id",
  "created_by_user_id",
  "name",
  "slug",
  "region",
  "status",
  "is_default",
  "runtime_template",
  "idle_timeout_minutes",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::text,
  organization."id",
  creator.user_id,
  'Default',
  'default',
  'iad',
  'requested',
  true,
  'kestrel-standard-v1',
  15,
  now(),
  now()
FROM "organization" organization
LEFT JOIN organization_creators creator
  ON creator.organization_id = organization."id"
WHERE NOT EXISTS (
  SELECT 1
  FROM "environments" environment
  WHERE environment."organization_id" = organization."id"
    AND environment."is_default" = true
    AND environment."archived_at" IS NULL
);

INSERT INTO "environment_operations" (
  "id",
  "organization_id",
  "environment_id",
  "requested_by_user_id",
  "type",
  "status",
  "stage",
  "idempotency_key",
  "input",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::text,
  environment."organization_id",
  environment."id",
  environment."created_by_user_id",
  'environment.provision',
  'queued',
  'environment.activation.requested',
  'environment.provision:' || environment."id",
  jsonb_build_object(
    'region', environment."region",
    'runtimeTemplate', environment."runtime_template"
  ),
  now(),
  now()
FROM "environments" environment
WHERE environment."status" = 'requested'
  AND environment."archived_at" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "environment_operations" operation
    WHERE operation."organization_id" = environment."organization_id"
      AND operation."idempotency_key" =
        'environment.provision:' || environment."id"
  );

ALTER TABLE "projects" ADD COLUMN "environment_id" text;

UPDATE "projects" project
SET "environment_id" = binding."environment_id"
FROM "project_environment_bindings" binding
WHERE binding."project_id" = project."id"
  AND binding."organization_id" = project."organization_id";

UPDATE "projects" project
SET "environment_id" = environment."id"
FROM "environments" environment
WHERE project."environment_id" IS NULL
  AND environment."organization_id" = project."organization_id"
  AND environment."is_default" = true
  AND environment."archived_at" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "projects" WHERE "environment_id" IS NULL) THEN
    RAISE EXCEPTION 'Every Project must resolve to an Environment';
  END IF;
END $$;

ALTER TABLE "projects" ALTER COLUMN "environment_id" SET NOT NULL;
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_organization_environment_fk"
  FOREIGN KEY ("organization_id", "environment_id")
  REFERENCES "environments" ("organization_id", "id")
  ON DELETE RESTRICT;
CREATE INDEX "projects_environment_id_idx"
  ON "projects" ("environment_id");

-- Keep the legacy binding projection synchronized during the controlled
-- cutover. New runtime reads use projects.environment_id as the authority.
INSERT INTO "project_environment_bindings" (
  "project_id",
  "organization_id",
  "environment_id",
  "created_at",
  "updated_at"
)
SELECT
  project."id",
  project."organization_id",
  project."environment_id",
  now(),
  now()
FROM "projects" project
ON CONFLICT ("project_id") DO UPDATE
SET
  "organization_id" = excluded."organization_id",
  "environment_id" = excluded."environment_id",
  "updated_at" = now();

-- Existing organization tool policy becomes the initial ceiling of the
-- default Environment without changing enabled/approval behavior.
INSERT INTO "environment_capability_grants" (
  "id",
  "environment_id",
  "provider_key",
  "capability_key",
  "approval_mode",
  "logging_mode",
  "rate_limit_mode",
  "settings",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::text,
  environment."id",
  capability."provider_key",
  capability."capability_key",
  capability."approval_mode",
  capability."logging_mode",
  capability."rate_limit_mode",
  capability."settings",
  now(),
  now()
FROM "environments" environment
JOIN "organization_tool_providers" provider
  ON provider."organization_id" = environment."organization_id"
 AND provider."enabled" = true
JOIN "organization_tool_capabilities" capability
  ON capability."organization_id" = provider."organization_id"
 AND capability."provider_key" = provider."provider_key"
 AND capability."enabled" = true
WHERE environment."is_default" = true
  AND environment."archived_at" IS NULL
ON CONFLICT ("environment_id", "provider_key", "capability_key")
  WHERE "resource_id" IS NULL
DO NOTHING;
