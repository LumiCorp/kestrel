import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "migrations");
const migration = fs.readFileSync(
  path.join(root, "0063_fly_release_compatibility.sql"),
  "utf8",
);
const journal = fs.readFileSync(path.join(root, "meta/_journal.json"), "utf8");

test("Fly release compatibility migration is additive and preserves legacy rows", () => {
  assert.match(journal, /0063_fly_release_compatibility/u);
  assert.match(migration, /"environment_gateway_config_version" integer/u);
  assert.match(
    migration,
    /"environment_gateway_accepted_versions" integer\[\]/u,
  );
  assert.match(migration, /"recovery_of_release_id" text/u);
  assert.doesNotMatch(migration, /NOT NULL|DROP TABLE|DROP COLUMN|DELETE FROM/u);
});
