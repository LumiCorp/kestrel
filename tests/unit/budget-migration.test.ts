import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("db/migrations/031_budget_integrity_ledger.sql", "utf8");

test("budget ledger migration persists atomic state and ordered durable entries", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS budget_repository_states/u);
  assert.match(migration, /state_json JSONB NOT NULL/u);
  assert.match(migration, /revision BIGINT NOT NULL/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS budget_ledger_entries/u);
  assert.match(migration, /REFERENCES budget_repository_states\(repository_id\) ON DELETE RESTRICT/u);
  assert.match(migration, /entry_json JSONB NOT NULL/u);
  assert.match(migration, /PRIMARY KEY \(repository_id, sequence\)/u);
  assert.match(migration, /UNIQUE \(repository_id, entry_id\)/u);
});
