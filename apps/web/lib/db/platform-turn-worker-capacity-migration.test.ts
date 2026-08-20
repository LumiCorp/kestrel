import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "./migrations/0077_platform_turn_worker_capacity.sql",
  import.meta.url,
);

test("Turn Worker capacity migration establishes bounded singleton admission", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /concurrency_per_machine.*DEFAULT 16/u);
  assert.match(migration, /concurrency_per_machine.*BETWEEN 1 AND 64/u);
  assert.match(migration, /desired_active_machines.*BETWEEN 1 AND 8/u);
  assert.match(migration, /admission_closed_until/u);
  assert.match(migration, /operation_lease_until/u);
  assert.match(migration, /operation_queued_at/u);
  assert.match(migration, /operation_state.*interrupted/u);
});

test("Turn concurrency groups are backfilled and strictly unique while running", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /project:' \|\| "threads"\."project_id"/u);
  assert.match(
    migration,
    /personal:' \|\| "threads"\."organization_id" \|\| ':' \|\| "threads"\."created_by_user_id"/u,
  );
  assert.match(migration, /ELSE 'thread:' \|\| "threads"\."id"/u);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "thread_turns_running_concurrency_group_idx"/u,
  );
  assert.match(
    migration,
    /WHERE "status" = 'running' AND "concurrency_group_key" IS NOT NULL/u,
  );
});
