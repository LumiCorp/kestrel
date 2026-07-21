import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0034_app_operation_approvals.sql"
  ),
  "utf8"
);

contractTest("web.hermetic", "App operation approvals bind runtime, capability, connection, resource, and payload", () => {
  assert.match(migration, /CREATE TABLE "app_operation_approvals"/u);
  for (const column of [
    "organization_id",
    "environment_id",
    "workspace_id",
    "thread_id",
    "requested_execution_id",
    "actor_user_id",
    "agent_id",
    "app_key",
    "capability_key",
    "connection_id",
    "resource_id",
    "resource_type",
    "operation_key",
    "runtime_approval_id",
    "payload_hash",
    "payload",
    "expires_at",
  ]) {
    assert.match(migration, new RegExp(`"${column}"`, "u"));
  }
  assert.match(migration, /app_operation_approvals_runtime_idx/u);
  assert.match(migration, /length\("payload_hash"\) = 64/u);
  assert.match(migration, /REFERENCES "organization"\("id"\)/u);
  assert.match(migration, /REFERENCES "user"\("id"\)/u);
  assert.doesNotMatch(migration, /REFERENCES "organizations"|REFERENCES "users"/u);
});

contractTest("web.hermetic", "App operation approvals enforce a single-use evidence lifecycle", () => {
  assert.match(
    migration,
    /'pending', 'approved', 'denied', 'consumed', 'expired'/u
  );
  assert.match(migration, /app_operation_approvals_lifecycle_check/u);
  assert.match(migration, /"consumed_execution_id" IS NOT NULL/u);
  assert.match(
    migration,
    /consumed_execution_fk[\s\S]*ON DELETE restrict/u
  );
  assert.match(migration, /"decided_by_user_id" IS NOT NULL/u);
});
