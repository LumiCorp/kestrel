import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(
  path.join(
    import.meta.dirname,
    "migrations/0076_schedule_titles_and_test_runs.sql",
  ),
  "utf8",
);

test("schedule titles and test-run identity are migrated durably", () => {
  assert.match(
    migration,
    /ALTER TABLE "project_prompt_schedules"[\s\S]*ADD COLUMN "title" text/u,
  );
  assert.match(migration, /SET "title" = 'Untitled schedule'/u);
  assert.match(migration, /ALTER COLUMN "title" SET NOT NULL/u);
  assert.match(migration, /ADD COLUMN "title_snapshot" text/u);
  assert.match(migration, /ADD COLUMN "trigger" text DEFAULT 'scheduled' NOT NULL/u);
  assert.match(migration, /ADD COLUMN "request_id" text/u);
  assert.match(
    migration,
    /SET "title_snapshot" = "schedules"\."title"/u,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "project_prompt_schedule_runs_request_idx"[\s\S]*\("schedule_id", "request_id"\)/u,
  );
  assert.doesNotMatch(
    migration,
    /DROP[^\n]*project_prompt_schedule_runs_occurrence_idx/u,
  );
});
