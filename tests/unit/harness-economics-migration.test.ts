import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { contractTest } from "../helpers/contract-test.js";

const migration = readFileSync("db/migrations/025_harness_economics_policy.sql", "utf8");

contractTest("runtime.hermetic", "harness economics migration adds an explicit version-indexed policy column", () => {
  assert.match(
    migration,
    /ALTER TABLE orchestration_context_policy_definitions[\s\S]+ADD COLUMN IF NOT EXISTS economics_policy_json JSONB/u,
  );
  assert.match(
    migration,
    /economics_policy_json ->> 'version'/u,
  );
});
