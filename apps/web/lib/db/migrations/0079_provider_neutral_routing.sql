DROP INDEX "environment_provider_resources_external_idx";

CREATE UNIQUE INDEX "environment_provider_resources_external_idx"
  ON "environment_provider_resources" USING btree (
    "provider_connection_id",
    "environment_id",
    "resource_role",
    "external_id"
  )
  WHERE "environment_provider_resources"."deleted_at" IS NULL;

ALTER TABLE "workspace_preview_leases"
  DROP CONSTRAINT "workspace_preview_leases_target_check";

ALTER TABLE "workspace_preview_leases"
  ALTER COLUMN "target_provider" SET DEFAULT 'hosted';

UPDATE "workspace_preview_leases"
SET "target_provider" = 'hosted'
WHERE "target_provider" = 'fly';

ALTER TABLE "workspace_preview_leases"
  ADD CONSTRAINT "workspace_preview_leases_target_check"
  CHECK (
    (
      "target_provider" IN ('hosted', 'fly')
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
    )
  );
