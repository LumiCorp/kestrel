ALTER TABLE "ai_gateways" ADD COLUMN IF NOT EXISTS "environment_id" text;
ALTER TABLE "ai_deployments" ADD COLUMN IF NOT EXISTS "environment_id" text;
ALTER TABLE "thread_turns" ADD COLUMN IF NOT EXISTS "requested_environment_id" text;

UPDATE "ai_deployments" deployment
SET "environment_id" = environment."id",
    "updated_at" = now()
FROM "environments" environment
WHERE deployment."environment_id" IS NULL
  AND environment."organization_id" = deployment."organization_id"
  AND environment."is_default" = true
  AND environment."archived_at" IS NULL;

UPDATE "ai_gateways" gateway
SET "environment_id" = deployment."environment_id",
    "updated_at" = now()
FROM "ai_deployments" deployment
WHERE gateway."deployment_id" = deployment."id"
  AND gateway."environment_id" IS NULL;

UPDATE "ai_gateways" gateway
SET "environment_id" = environment."id",
    "updated_at" = now()
FROM "environments" environment
WHERE gateway."environment_id" IS NULL
  AND gateway."organization_id" = environment."organization_id"
  AND gateway."provider" = 'runpod'
  AND environment."is_default" = true
  AND environment."archived_at" IS NULL;

UPDATE "thread_turns" turn
SET "requested_environment_id" = execution."environment_id"
FROM "environment_run_executions" execution
WHERE turn."requested_environment_id" IS NULL
  AND turn."environment_execution_id" = execution."id";

UPDATE "thread_turns" turn
SET "requested_environment_id" = binding."environment_id"
FROM "thread_execution_bindings" binding
WHERE turn."requested_environment_id" IS NULL
  AND turn."thread_id" = binding."thread_id"
  AND turn."organization_id" = binding."organization_id";

UPDATE "thread_turns" turn
SET "requested_environment_id" = project."environment_id"
FROM "threads" thread
JOIN "projects" project ON project."id" = thread."project_id"
WHERE turn."requested_environment_id" IS NULL
  AND turn."thread_id" = thread."id"
  AND turn."organization_id" = project."organization_id";

UPDATE "thread_turns" turn
SET "requested_environment_id" = environment."id"
FROM "environments" environment
WHERE turn."requested_environment_id" IS NULL
  AND turn."organization_id" = environment."organization_id"
  AND environment."is_default" = true
  AND environment."archived_at" IS NULL;

ALTER TABLE "ai_gateways"
  ADD CONSTRAINT "ai_gateways_organization_environment_fk"
  FOREIGN KEY ("organization_id", "environment_id")
  REFERENCES "environments" ("organization_id", "id")
  ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE "ai_gateways"
  ADD CONSTRAINT "ai_gateways_environment_scope_check"
  CHECK ("environment_id" IS NULL OR "organization_id" IS NOT NULL)
  NOT VALID;

ALTER TABLE "ai_deployments"
  ADD CONSTRAINT "ai_deployments_organization_environment_fk"
  FOREIGN KEY ("organization_id", "environment_id")
  REFERENCES "environments" ("organization_id", "id")
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_organization_environment_fk"
  FOREIGN KEY ("organization_id", "requested_environment_id")
  REFERENCES "environments" ("organization_id", "id")
  ON DELETE RESTRICT
  NOT VALID;

DROP INDEX IF EXISTS "ai_deployments_active_org_profile_idx";
CREATE UNIQUE INDEX "ai_deployments_active_environment_profile_idx"
  ON "ai_deployments" ("environment_id", "profile_id")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "ai_deployments_environment_id_idx"
  ON "ai_deployments" ("environment_id");
CREATE INDEX "ai_gateways_environment_id_idx"
  ON "ai_gateways" ("environment_id");
DROP INDEX IF EXISTS "ai_gateways_org_provider_display_name_idx";
CREATE UNIQUE INDEX "ai_gateways_org_shared_provider_display_name_idx"
  ON "ai_gateways" ("organization_id", "provider", "display_name")
  WHERE "organization_id" IS NOT NULL AND "environment_id" IS NULL;
CREATE UNIQUE INDEX "ai_gateways_environment_provider_display_name_idx"
  ON "ai_gateways" ("environment_id", "provider", "display_name")
  WHERE "environment_id" IS NOT NULL;
CREATE INDEX "thread_turns_environment_idx"
  ON "thread_turns" ("requested_environment_id");

CREATE TABLE "environment_ai_model_defaults" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL,
  "modality" text NOT NULL,
  "model_id" text NOT NULL REFERENCES "ai_gateway_models"("id") ON DELETE cascade,
  "updated_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("environment_id", "modality"),
  CONSTRAINT "environment_ai_model_defaults_modality_check"
    CHECK ("modality" IN ('language', 'image', 'speech', 'video', 'embedding')),
  CONSTRAINT "environment_ai_model_defaults_organization_environment_fk"
    FOREIGN KEY ("organization_id", "environment_id")
    REFERENCES "environments" ("organization_id", "id")
    ON DELETE CASCADE
);

CREATE INDEX "environment_ai_model_defaults_model_idx"
  ON "environment_ai_model_defaults" ("model_id");

INSERT INTO "organization_ai_deployment_policies" (
  "organization_id",
  "enabled",
  "max_active_deployments",
  "created_at",
  "updated_at"
)
SELECT "id", true, 2, now(), now()
FROM "organization"
ON CONFLICT ("organization_id") DO UPDATE
SET "enabled" = true,
    "max_active_deployments" = 2,
    "updated_at" = now();

CREATE OR REPLACE FUNCTION "seed_default_ai_deployment_policy"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "organization_ai_deployment_policies" (
    "organization_id",
    "enabled",
    "max_active_deployments",
    "created_at",
    "updated_at"
  )
  VALUES (NEW."id", true, 2, now(), now())
  ON CONFLICT ("organization_id") DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "organization_default_ai_deployment_policy" ON "organization";
CREATE TRIGGER "organization_default_ai_deployment_policy"
AFTER INSERT ON "organization"
FOR EACH ROW
EXECUTE FUNCTION "seed_default_ai_deployment_policy"();

WITH eligible AS (
  SELECT
    gateway."organization_id",
    gateway."environment_id",
    min(model."id") AS model_id,
    count(*) AS model_count
  FROM "ai_gateways" gateway
  JOIN "ai_gateway_models" model ON model."gateway_id" = gateway."id"
  LEFT JOIN "ai_deployments" deployment ON deployment."gateway_id" = gateway."id"
  WHERE gateway."environment_id" IS NOT NULL
    AND gateway."enabled" = true
    AND model."approved" = true
    AND model."modality" = 'language'
    AND (deployment."id" IS NULL OR deployment."status" = 'ready')
  GROUP BY gateway."organization_id", gateway."environment_id"
  HAVING count(*) = 1
)
INSERT INTO "environment_ai_model_defaults" (
  "organization_id",
  "environment_id",
  "modality",
  "model_id",
  "created_at",
  "updated_at"
)
SELECT
  eligible."organization_id",
  eligible."environment_id",
  'language',
  eligible.model_id,
  now(),
  now()
FROM eligible;
