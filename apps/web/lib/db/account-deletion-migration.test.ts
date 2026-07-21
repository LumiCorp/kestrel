import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0024_account_deletion_requests.sql"),
  "utf8"
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8"
);

contractTest("web.hermetic", "account deletion requests require confirmation and preserve status evidence", () => {
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS "account_deletion_requests"/u
  );
  assert.match(migration, /confirmation_token_hash/u);
  assert.match(migration, /account_deletion_requests_status_check/u);
  assert.match(migration, /account_deletion_requests_terminal_time_check/u);
  assert.match(migration, /ON DELETE cascade/u);
});

contractTest("web.hermetic", "account deletion request migration is registered", () => {
  assert.match(journal, /"tag": "0024_account_deletion_requests"/u);
});
