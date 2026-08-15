import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(
  path.join(
    import.meta.dirname,
    "migrations/0071_durable_runtime_image_authority.sql",
  ),
  "utf8",
);

test("migration 0071 persists worker contract acknowledgement and heartbeat evidence", () => {
  assert.match(migration, /configuration_contract_fingerprint/u);
  assert.match(migration, /turn_worker_configuration_approved_by_user_id/u);
  assert.match(migration, /CREATE TABLE "platform_worker_heartbeats"/u);
  assert.match(migration, /PRIMARY KEY \("worker_role", "machine_id"\)/u);
  assert.match(migration, /source_revision/u);
  assert.match(migration, /configuration_fingerprint/u);
  assert.doesNotMatch(migration, /secret_value|request_body/u);
});
