import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0082_hosted_app_approval_integrity.sql"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(path.join(directory, "migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };

test("hosted App approval migration separates every transaction identity and failure state", () => {
  for (const column of [
    "runtime_approval_id",
    "source_runtime_run_id",
    "response_failure_code",
    "response_failure_message",
    "effect_status",
    "response_retryable",
    "resume_interaction_id",
    "failure_code",
    "failure_message",
  ]) {
    assert.match(migration, new RegExp(`"${column}"`, "u"));
  }
  assert.match(migration, /thread_turns_active_interaction_retry_idx/u);
  assert.match(migration, /'google_workspace'/u);
  assert.match(migration, /'microsoft_365'/u);
  assert.match(migration, /UPDATE "github_action_approvals"[\s\S]*'expired'/u);
  assert.deepEqual(
    journal.entries.find((entry) => entry.tag === "0082_hosted_app_approval_integrity"),
    { idx: 82, version: "7", when: 1_787_677_200_000, tag: "0082_hosted_app_approval_integrity", breakpoints: true },
  );
});
