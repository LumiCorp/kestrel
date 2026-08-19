import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migration = fs.readFileSync(
  path.join(appRoot, "lib/db/migrations/0078_kubernetes_lifecycle_replacements.sql"),
  "utf8",
);
const journal = fs.readFileSync(
  path.join(appRoot, "lib/db/migrations/meta/_journal.json"),
  "utf8",
);

test("replacement resources coexist without changing primary or snapshot identity", () => {
  assert.match(migration, /ADD COLUMN "replacement_id" text/u);
  assert.match(migration, /workspace_replacement_idx/u);
  assert.match(migration, /"replacement_id" IS NULL/u);
  assert.match(migration, /"resource_role" IN \('workspace_compute', 'workspace_storage'\)/u);
  const schemaChanges = migration.split(
    'CREATE OR REPLACE FUNCTION "kestrel_sync_fly_workspace_resources"()',
  )[0]!;
  assert.doesNotMatch(schemaChanges, /UPDATE "environment_provider_resources"/u);
  assert.match(
    migration,
    /ON CONFLICT \("workspace_id", "resource_role"\)[\s\S]*?"replacement_id" IS NULL/u,
  );
  assert.match(
    migration,
    /WHERE "workspace_id" = NEW\."id" AND "replacement_id" IS NULL/u,
  );
  assert.doesNotMatch(migration, /DROP COLUMN/u);
  assert.match(journal, /0078_kubernetes_lifecycle_replacements/u);
});
