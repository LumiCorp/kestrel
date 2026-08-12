import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "./migrations/0061_run_scoped_authorization.sql",
  import.meta.url,
);

test("run-scoped authorization migration adds nullable execution authority", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /"authorization_renewal_token_hash" text/u);
  assert.match(migration, /"project_context_grant_id" text/u);
  assert.doesNotMatch(migration, /NOT NULL|CREATE INDEX|UPDATE /u);
});
