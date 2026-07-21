import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0035_provider_reasoning_policy.sql"),
  "utf8",
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8",
);

contractTest("web.hermetic", "Environment provider reasoning policy defaults to live-only seven-day retention", () => {
  assert.match(migration, /reasoning_request_mode[\s\S]*DEFAULT 'provider_visible'/u);
  assert.match(migration, /reasoning_retention_mode[\s\S]*DEFAULT 'live_only'/u);
  assert.match(migration, /reasoning_retention_days[\s\S]*DEFAULT 7/u);
  assert.match(migration, /BETWEEN 1 AND 30/u);
});

contractTest("web.hermetic", "Environment run inspection snapshots runtime identity and key readiness", () => {
  assert.match(migration, /environment_run_executions/u);
  assert.match(migration, /runtime_run_id/u);
  assert.match(migration, /reasoning_policy_snapshot/u);
  assert.match(migration, /reasoning_key_ready[\s\S]*DEFAULT false/u);
});

contractTest("web.hermetic", "Environment provider reasoning policy migration is registered", () => {
  assert.match(journal, /"tag": "0035_provider_reasoning_policy"/u);
});
