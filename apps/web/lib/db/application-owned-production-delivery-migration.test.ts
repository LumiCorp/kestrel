import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(
  path.join(
    import.meta.dirname,
    "migrations/0073_application_owned_production_delivery.sql",
  ),
  "utf8",
);
const manualRuntimeMigration = fs.readFileSync(
  path.join(import.meta.dirname, "migrations/0074_manual_runtime_tags.sql"),
  "utf8",
);

test("migration 0073 adds only runtime desired state and production build tags", () => {
  assert.match(migration, /ADD COLUMN "desired_version_id"/u);
  assert.match(migration, /:production-\[1-9\]/u);
  assert.doesNotMatch(migration, /DROP NOT NULL/u);
  assert.doesNotMatch(
    migration,
    /DROP CONSTRAINT "environment_runtime_versions_.*revision_check"/u,
  );
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|TRUNCATE/u);
});

test("migration 0074 removes automated production delivery state", () => {
  assert.match(manualRuntimeMigration, /DROP COLUMN IF EXISTS "workspace_runtime_source_revision"/u);
  assert.match(manualRuntimeMigration, /DROP COLUMN IF EXISTS "desired_version_id"/u);
  assert.match(manualRuntimeMigration, /DROP TABLE IF EXISTS "fly_image_release_attempts"/u);
  assert.match(manualRuntimeMigration, /DROP TABLE IF EXISTS "release_controller_heartbeats"/u);
  assert.doesNotMatch(manualRuntimeMigration, /ADD COLUMN|CREATE TABLE|INSERT INTO/u);
});
