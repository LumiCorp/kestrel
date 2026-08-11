import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  "db/migrations/032_interaction_request_envelopes.sql",
  "utf8",
);

test("structured review migration adds only the nullable interaction envelope", () => {
  assert.match(
    migration,
    /ALTER TABLE orchestration_interaction_requests/u,
  );
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS interaction_json JSONB/u,
  );
  assert.doesNotMatch(migration, /NOT NULL|DROP COLUMN|DELETE FROM/iu);
});
