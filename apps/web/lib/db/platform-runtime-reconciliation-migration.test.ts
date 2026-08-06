import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "migrations");
const migration = fs.readFileSync(
  path.join(root, "0061_platform_runtime_reconciliation.sql"),
  "utf8",
);
const journal = fs.readFileSync(path.join(root, "meta/_journal.json"), "utf8");

test("platform runtime migration is additive and backfills verified state", () => {
  assert.match(journal, /0061_platform_runtime_reconciliation/u);
  assert.match(migration, /CREATE TABLE "platform_runtime_settings"/u);
  assert.match(migration, /"target_generation" integer/u);
  assert.match(migration, /stable\."bundle_revision"/u);
  assert.match(migration, /router\."image"/u);
  assert.match(migration, /runtime\."image"/u);
  assert.match(migration, /ON CONFLICT \("id"\) DO NOTHING/u);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM/u);
});
