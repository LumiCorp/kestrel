import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "migrations");
const migration = fs.readFileSync(
  path.join(root, "0095_autonomous_workflow_activation.sql"),
  "utf8",
);

test("workflow activation migration cuts existing automation over to Draft", () => {
  assert.match(migration, /project_workflow_version_activations/u);
  assert.match(migration, /active_version_id/u);
  assert.match(migration, /workflow_workspace_id/u);
  assert.match(migration, /activation_manifest_digest/u);
  assert.match(migration, /SET "enabled" = false, "next_run_at" = NULL/u);
});
