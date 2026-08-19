import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");

test("provider-neutral routing migration is additive and keeps rollback readers", async () => {
  const migration = await readFile(
    path.join(root, "0079_provider_neutral_routing.sql"),
    "utf8",
  );
  assert.match(
    migration,
    /"provider_connection_id",\s+"environment_id",\s+"resource_role",\s+"external_id"/u,
  );
  assert.match(migration, /SET "target_provider" = 'hosted'[\s\S]*WHERE "target_provider" = 'fly'/u);
  assert.match(migration, /DEFAULT 'hosted'/u);
  assert.match(migration, /IN \('hosted', 'fly'\)/u);
  assert.match(migration, /= 'desktop'/u);
  assert.doesNotMatch(migration, /DROP COLUMN/u);
  assert.doesNotMatch(migration, /DELETE FROM/u);
});
