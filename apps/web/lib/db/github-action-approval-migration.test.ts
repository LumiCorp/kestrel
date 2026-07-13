import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0017_github_action_approvals.sql"
  ),
  "utf8"
);
const journal = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "migrations/meta/_journal.json"
    ),
    "utf8"
  )
) as { entries: Array<{ idx: number; tag: string }> };

test("GitHub action approvals bind the actor, runtime, resource, and payload", () => {
  assert.match(migration, /CREATE TABLE "github_action_approvals"/u);
  for (const column of [
    "organization_id",
    "environment_id",
    "workspace_id",
    "thread_id",
    "requested_execution_id",
    "actor_user_id",
    "agent_id",
    "resource_id",
    "repository",
    "operation",
    "runtime_approval_id",
    "payload_hash",
    "payload",
    "expires_at",
  ]) {
    assert.match(migration, new RegExp(`"${column}"`, "u"));
  }
  assert.match(migration, /github_action_approvals_runtime_idx/u);
  assert.match(migration, /\^\[0-9a-f\]\{64\}\$/u);
});

test("GitHub action approvals enforce single-use lifecycle evidence", () => {
  assert.match(
    migration,
    /'pending', 'approved', 'denied', 'consumed', 'expired'/u
  );
  assert.match(migration, /github_action_approvals_lifecycle_check/u);
  assert.match(migration, /"consumed_execution_id" IS NOT NULL/u);
  assert.match(migration, /consumed_execution_fk[\s\S]*ON DELETE RESTRICT/u);
  assert.match(migration, /"decided_by_user_id" IS NOT NULL/u);
  assert.deepEqual(journal.entries.at(-1), {
    idx: 17,
    version: "7",
    when: 1_783_972_800_000,
    tag: "0017_github_action_approvals",
    breakpoints: true,
  });
});
