import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0016_organization_feature_flags.sql"
  ),
  "utf8"
);
const journal = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "migrations/meta/_journal.json"
    ),
    "utf8"
  )
) as { entries: Array<{ idx: number; tag: string }> };

test("organization feature flags are tenant-owned and administrator-attributed", () => {
  assert.match(migration, /CREATE TABLE "organization_feature_flags"/u);
  assert.match(migration, /PRIMARY KEY \("organization_id", "key"\)/u);
  assert.match(migration, /"enabled" boolean DEFAULT false NOT NULL/u);
  assert.match(migration, /"updated_by_user_id" text NOT NULL/u);
  assert.match(
    migration,
    /REFERENCES "organization"\("id"\) ON DELETE CASCADE/u
  );
  assert.match(migration, /REFERENCES "user"\("id"\) ON DELETE RESTRICT/u);
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0016_organization_feature_flags"
    ),
    {
      idx: 16,
      version: "7",
      when: 1_783_944_000_000,
      tag: "0016_organization_feature_flags",
      breakpoints: true,
    }
  );
});
