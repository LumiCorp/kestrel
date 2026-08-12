import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrations = path.resolve(import.meta.dirname, "migrations");
const migration = fs.readFileSync(
  path.join(migrations, "0062_runtime_event_cursor.sql"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };

test("runtime continuity migration adds a nullable cursor and typed preview inspection", () => {
  assert.match(
    migration,
    /ALTER TABLE "environment_run_executions"[\s\S]*ADD COLUMN "last_runtime_event_id" text/u,
  );
  assert.doesNotMatch(migration, /last_runtime_event_id" text NOT NULL/u);
  assert.match(migration, /'workspace\.preview\.inspect'/u);
  assert.match(migration, /ON CONFLICT \("provider_key", "key"\)/u);
  assert.match(migration, /ON CONFLICT \("app_key", "key"\)/u);
});

test("runtime continuity migration is registered after the previous migration", () => {
  assert.deepEqual(journal.entries.at(-1), {
    idx: 62,
    version: "7",
    when: 1_786_467_600_000,
    tag: "0062_runtime_event_cursor",
    breakpoints: true,
  });
});
