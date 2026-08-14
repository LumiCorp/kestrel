import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relativePath: string) =>
  fs.readFileSync(path.join(appRoot, relativePath), "utf8");

test("Project prompt schedules persist tenant-safe definitions and durable occurrences", () => {
  const migration = read(
    "lib/db/migrations/0070_project_prompt_schedules.sql",
  );
  assert.match(migration, /CREATE TABLE "project_prompt_schedules"/u);
  assert.match(migration, /CREATE TABLE "project_prompt_schedule_runs"/u);
  assert.match(
    migration,
    /FOREIGN KEY \("organization_id","project_id"\).*projects.*\("organization_id","id"\).*ON DELETE cascade/u,
  );
  assert.match(
    migration,
    /UNIQUE\("schedule_id","scheduled_for"\)/u,
  );
  assert.match(migration, /"prompt_snapshot" text NOT NULL/u);
  assert.match(migration, /"next_run_at" timestamp with time zone/u);
  assert.match(migration, /project_prompt_schedules_due_idx/u);
  assert.match(
    migration,
    /CREATE TRIGGER "member_delete_pause_project_prompt_schedules"[\s\S]*BEFORE DELETE ON "member"/u,
  );
  assert.match(
    migration,
    /"pause_reason" = 'creator_access_lost'[\s\S]*"created_by_user_id" = OLD\."userId"/u,
  );
  assert.doesNotMatch(
    migration,
    /project_prompt_schedule_runs_thread_id_threads_id_fk/u,
    "a stable Thread ID must be reservable before materialization",
  );
});
