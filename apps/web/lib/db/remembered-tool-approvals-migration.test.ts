import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0083_remembered_tool_approvals.sql"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(path.join(directory, "migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<Record<string, unknown>> };
const historyLock = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/history-lock.json"),
    "utf8",
  ),
) as Record<string, string>;

test("remembered approval migration has complete identity uniqueness and thread lifetime", () => {
  for (const column of [
    "organization_id",
    "thread_id",
    "actor_user_id",
    "tool_id",
    "descriptor_contract_revision",
    "approval_authority_revision",
    "source_interaction_id",
  ]) {
    assert.match(migration, new RegExp(`"${column}"`, "u"));
  }
  assert.match(
    migration,
    /remembered_tool_approvals_thread_fk[\s\S]*REFERENCES "threads"\("id"\)[\s\S]*ON DELETE CASCADE/u,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "remembered_tool_approvals_identity_idx"[\s\S]*"organization_id"[\s\S]*"thread_id"[\s\S]*"actor_user_id"[\s\S]*"tool_id"[\s\S]*"descriptor_contract_revision"[\s\S]*"approval_authority_revision"/u,
  );
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0083_remembered_tool_approvals",
    ),
    {
      idx: 83,
      version: "7",
      when: 1_787_763_600_000,
      tag: "0083_remembered_tool_approvals",
      breakpoints: true,
    },
  );
  assert.equal(
    historyLock["0083_remembered_tool_approvals"],
    `1787763600000:${createHash("sha256").update(migration).digest("hex")}`,
  );
});
