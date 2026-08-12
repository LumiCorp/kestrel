import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(
  path.join(
    import.meta.dirname,
    "migrations/0065_ai_gateway_credential_health.sql"
  ),
  "utf8"
);

test("credential health migration preserves existing gateways and grant evidence", () => {
  assert.match(migration, /ADD COLUMN "credential_status"/u);
  assert.match(migration, /ADD COLUMN "credential_validated_at"/u);
  assert.match(migration, /ADD COLUMN "credential_revision"/u);
  assert.match(migration, /WHEN "provider" = 'ollama' THEN 'not_required'/u);
  assert.match(migration, /"provider_connection_id" IS NOT NULL/u);
  assert.match(migration, /"deployment_id" IS NOT NULL/u);
  assert.match(migration, /ADD COLUMN "gateway_credential_revision"/u);
  assert.match(
    migration,
    /model_grant\."gateway_id" = gateway\."id"/u
  );
  assert.match(
    migration,
    /"status" <> 'active' OR "gateway_credential_revision" IS NOT NULL/u
  );
});
