import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0056_external_approval_bindings.sql"),
  "utf8",
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8",
);

test("external approval migration expires unbound executable App approvals", () => {
  assert.match(migration, /external_approval_binding/u);
  assert.match(migration, /authority_revision/u);
  assert.match(migration, /"status" IN \('pending', 'approved'\)/u);
  assert.match(migration, /SET "status" = 'expired'/u);
  assert.doesNotMatch(migration, /DELETE FROM/u);
  assert.match(journal, /0056_external_approval_bindings/u);
});
