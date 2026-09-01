import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0094_exact_exec_command_approval_scope.sql"),
  "utf8",
);
const historyLock = JSON.parse(
  fs.readFileSync(path.join(directory, "migrations/meta/history-lock.json"), "utf8"),
) as Record<string, string>;

test("exact command approval migration resets broad evidence and scopes uniqueness", () => {
  assert.match(migration, /DELETE FROM "remembered_tool_approvals"/u);
  for (const column of ["scope_kind", "scope_key", "scope_payload"]) {
    assert.match(migration, new RegExp(`"${column}"`, "u"));
  }
  assert.match(
    migration,
    /remembered_tool_approvals_identity_idx[\s\S]*"scope_kind"[\s\S]*"scope_key"/u,
  );
  assert.equal(
    historyLock["0094_exact_exec_command_approval_scope"],
    `1787943600000:${createHash("sha256").update(migration).digest("hex")}`,
  );
});
