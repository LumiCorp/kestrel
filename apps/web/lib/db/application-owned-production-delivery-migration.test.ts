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
