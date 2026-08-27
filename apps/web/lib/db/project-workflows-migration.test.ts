import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0085_project_workflows.sql"),
  "utf8",
);

test("project workflows persist immutable graphs and durable step evidence", () => {
  assert.match(migration, /CREATE TABLE "project_workflows"/u);
  assert.match(migration, /CREATE TABLE "project_workflow_versions"/u);
  assert.match(migration, /CREATE TABLE "project_workflow_runs"/u);
  assert.match(migration, /CREATE TABLE "project_workflow_step_runs"/u);
  assert.match(
    migration,
    /project_workflow_versions_workflow_version_idx/u,
  );
  assert.match(migration, /project_workflow_runs_request_idx/u);
  assert.match(migration, /project_workflow_runs_occurrence_idx/u);
  assert.match(migration, /project_workflow_step_runs_turn_id_thread_turns_id_fk/u);
});
