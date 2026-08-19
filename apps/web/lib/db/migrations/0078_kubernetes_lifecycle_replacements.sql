ALTER TABLE "environment_provider_resources" ADD COLUMN "replacement_id" text;

DROP INDEX "environment_provider_resources_workspace_singleton_idx";

CREATE UNIQUE INDEX "environment_provider_resources_workspace_singleton_idx"
  ON "environment_provider_resources" USING btree ("workspace_id", "resource_role")
  WHERE "environment_provider_resources"."workspace_id" IS NOT NULL
    AND "environment_provider_resources"."replacement_id" IS NULL
    AND "environment_provider_resources"."deleted_at" IS NULL
    AND "environment_provider_resources"."resource_role" <> 'snapshot';

CREATE UNIQUE INDEX "environment_provider_resources_workspace_replacement_idx"
  ON "environment_provider_resources" USING btree ("workspace_id", "resource_role", "replacement_id")
  WHERE "environment_provider_resources"."workspace_id" IS NOT NULL
    AND "environment_provider_resources"."replacement_id" IS NOT NULL
    AND "environment_provider_resources"."deleted_at" IS NULL
    AND "environment_provider_resources"."resource_role" IN ('workspace_compute', 'workspace_storage');

DROP INDEX "environment_provider_resources_workspace_idx";

CREATE INDEX "environment_provider_resources_workspace_idx"
  ON "environment_provider_resources" USING btree ("workspace_id", "replacement_id", "deleted_at");

ALTER TABLE "environment_provider_resources"
  ADD CONSTRAINT "environment_provider_resources_replacement_check"
  CHECK (
    "replacement_id" IS NULL
    OR (
      "workspace_id" IS NOT NULL
      AND "resource_role" IN ('workspace_compute', 'workspace_storage')
    )
  );

-- Keep the legacy Fly dual-write trigger pinned to the primary resource row.
-- Its original conflict predicate matched the pre-replacement singleton index;
-- once replacements are permitted, both conflict inference and tombstoning must
-- explicitly exclude replacement rows.
CREATE OR REPLACE FUNCTION "kestrel_sync_fly_workspace_resources"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  environment_provider text;
  connection_id text;
BEGIN
  SELECT "provider", "provider_connection_id" INTO environment_provider, connection_id
  FROM "environments" WHERE "id" = NEW."environment_id";
  IF environment_provider <> 'fly' OR connection_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."fly_machine_id" IS NOT NULL THEN
    INSERT INTO "environment_provider_resources" (
      "id", "organization_id", "environment_id", "workspace_id", "replacement_id", "provider_connection_id",
      "provider", "resource_role", "external_id", "desired_revision",
      "observed_generation", "state", "provider_metadata", "deleted_at", "updated_at"
    ) VALUES (
      'fly-resource:' || md5(NEW."id" || ':workspace_compute'), NEW."organization_id", NEW."environment_id", NEW."id", NULL,
      connection_id, 'fly', 'workspace_compute', NEW."fly_machine_id", 'legacy-v1',
      NEW."fly_machine_id", NEW."status",
      '{"contract":"provider-resource-metadata-v1","source":"legacy_dual_write"}'::jsonb, NULL, now()
    )
    ON CONFLICT ("workspace_id", "resource_role")
      WHERE "workspace_id" IS NOT NULL AND "replacement_id" IS NULL
        AND "deleted_at" IS NULL AND "resource_role" <> 'snapshot'
    DO UPDATE SET
      "external_id" = excluded."external_id",
      "observed_generation" = excluded."observed_generation",
      "state" = excluded."state",
      "provider_metadata" = excluded."provider_metadata",
      "updated_at" = now()
    WHERE "environment_provider_resources"."external_id" = excluded."external_id"
      OR "environment_provider_resources"."provider_metadata" ->> 'source'
        IN ('legacy_backfill', 'legacy_dual_write', 'read_repair');
  ELSE
    UPDATE "environment_provider_resources"
    SET "deleted_at" = now(), "state" = 'deleted', "updated_at" = now()
    WHERE "workspace_id" = NEW."id" AND "replacement_id" IS NULL
      AND "resource_role" = 'workspace_compute' AND "deleted_at" IS NULL;
  END IF;

  IF NEW."fly_volume_id" IS NOT NULL THEN
    INSERT INTO "environment_provider_resources" (
      "id", "organization_id", "environment_id", "workspace_id", "replacement_id", "provider_connection_id",
      "provider", "resource_role", "external_id", "desired_revision",
      "observed_generation", "state", "provider_metadata", "deleted_at", "updated_at"
    ) VALUES (
      'fly-resource:' || md5(NEW."id" || ':workspace_storage'), NEW."organization_id", NEW."environment_id", NEW."id", NULL,
      connection_id, 'fly', 'workspace_storage', NEW."fly_volume_id", 'legacy-v1',
      NEW."fly_volume_id", NEW."status",
      '{"contract":"provider-resource-metadata-v1","source":"legacy_dual_write"}'::jsonb, NULL, now()
    )
    ON CONFLICT ("workspace_id", "resource_role")
      WHERE "workspace_id" IS NOT NULL AND "replacement_id" IS NULL
        AND "deleted_at" IS NULL AND "resource_role" <> 'snapshot'
    DO UPDATE SET
      "external_id" = excluded."external_id",
      "observed_generation" = excluded."observed_generation",
      "state" = excluded."state",
      "provider_metadata" = excluded."provider_metadata",
      "updated_at" = now()
    WHERE "environment_provider_resources"."external_id" = excluded."external_id"
      OR "environment_provider_resources"."provider_metadata" ->> 'source'
        IN ('legacy_backfill', 'legacy_dual_write', 'read_repair');
  ELSE
    UPDATE "environment_provider_resources"
    SET "deleted_at" = now(), "state" = 'deleted', "updated_at" = now()
    WHERE "workspace_id" = NEW."id" AND "replacement_id" IS NULL
      AND "resource_role" = 'workspace_storage' AND "deleted_at" IS NULL;
  END IF;
  RETURN NEW;
END $$;
