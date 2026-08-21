import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

test("Kubernetes control-plane migration permits command sequences per operation", async () => {
  const migration = await readFile(
    path.join(migrations, "0080_kubernetes_byoc_control_plane.sql"),
    "utf8",
  );
  assert.match(
    migration,
    /DROP INDEX "infrastructure_connector_commands_operation_idx"/u,
  );
  assert.match(
    migration,
    /CREATE INDEX "infrastructure_connector_commands_operation_idx"/u,
  );
  assert.doesNotMatch(
    migration,
    /CREATE UNIQUE INDEX "infrastructure_connector_commands_operation_idx"/u,
  );
  assert.match(migration, /'environment\.reconcile'/u);
  assert.doesNotMatch(migration, /DROP COLUMN|DELETE FROM/u);
});
