import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(
  path.join(
    import.meta.dirname,
    "migrations/0075_project_prompt_schedule_models.sql",
  ),
  "utf8",
);

test("scheduled prompts persist a model and snapshot it per occurrence", () => {
  assert.match(
    migration,
    /ALTER TABLE "project_prompt_schedules"[\s\S]*ADD COLUMN "model_id" text/u,
  );
  assert.match(
    migration,
    /ALTER TABLE "project_prompt_schedule_runs"[\s\S]*ADD COLUMN "model_id_snapshot" text/u,
  );
  assert.doesNotMatch(
    migration,
    /REFERENCES/u,
    "model selections include aliases and Desktop-local identities, so the runtime validates them against the bound Environment",
  );
});
