import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("db/migrations/024_provider_reasoning_state.sql", "utf8");

test("provider reasoning storage separates encrypted continuation, retained content, and access audit", () => {
  assert.match(migration, /record_kind IN \('continuation', 'retained_visible'\)/u);
  assert.match(migration, /retention_scope TEXT NOT NULL/u);
  for (const encryptedColumn of ["ciphertext", "iv", "auth_tag", "key_version"]) {
    assert.match(migration, new RegExp(`${encryptedColumn} (?:TEXT|INTEGER) NOT NULL`, "u"));
  }
  assert.doesNotMatch(migration, /plaintext|visible_text|reasoning_text/iu);
  assert.match(migration, /provider_reasoning_access_audit/u);
  assert.match(migration, /'read', 'delete', 'policy_change'/u);
});

test("provider reasoning storage supports exact continuation and expiry cleanup", () => {
  assert.match(migration, /idx_provider_reasoning_active_continuation/u);
  assert.match(migration, /WHERE record_kind = 'continuation'/u);
  assert.match(migration, /idx_provider_reasoning_expiry/u);
  assert.match(migration, /idx_provider_reasoning_retention_scope/u);
});
