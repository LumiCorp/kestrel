import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migration = fs.readFileSync(
  path.join(appRoot, "lib/db/migrations/0077_kubernetes_connector_trust.sql"),
  "utf8",
);
const journal = fs.readFileSync(
  path.join(appRoot, "lib/db/migrations/meta/_journal.json"),
  "utf8",
);

test("connector enrollment is created before tenant binding", () => {
  assert.match(migration, /ALTER COLUMN "organization_id" DROP NOT NULL/u);
  assert.match(migration, /ALTER COLUMN "provider_connection_id" DROP NOT NULL/u);
  assert.match(migration, /"consumption_envelope" jsonb/u);
  assert.match(
    migration,
    /ON "infrastructure_connector_enrollment_requests" \("fingerprint"\)/u,
  );
});

test("qualification commands have a durable non-Environment owner", () => {
  assert.match(migration, /CREATE TABLE "infrastructure_connector_qualification_runs"/u);
  assert.match(migration, /"qualification_run_id" text/u);
  assert.match(migration, /num_nonnulls\("operation_id", "qualification_run_id"\) = 1/u);
  assert.match(migration, /infrastructure_connector_commands_qualification_idx/u);
  assert.match(journal, /0077_kubernetes_connector_trust/u);
});
