import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const migration = fs.readFileSync(
  path.join(
    appRoot,
    "lib/db/migrations/0076_kubernetes_byoc_persistence.sql",
  ),
  "utf8",
);
const journal = fs.readFileSync(
  path.join(appRoot, "lib/db/migrations/meta/_journal.json"),
  "utf8",
);

test("Kubernetes BYOC persistence is additive, tenant-scoped, and rollback-safe", () => {
  for (const table of [
    "environment_provider_connections",
    "environment_provider_resources",
    "infrastructure_connector_enrollment_requests",
    "infrastructure_connector_connections",
    "infrastructure_connector_replica_presence",
    "infrastructure_connector_request_nonces",
    "infrastructure_connector_commands",
    "infrastructure_connector_command_events",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`, "u"));
  }
  assert.match(migration, /ADD COLUMN "provider_connection_id" text/u);
  assert.match(migration, /ADD COLUMN "provider_placement" jsonb/u);
  assert.match(migration, /ADD COLUMN "workspace_limit" integer/u);
  assert.match(migration, /ALTER COLUMN "region" DROP NOT NULL/u);
  assert.match(
    migration,
    /CHECK \("provider" IN \('fly', 'desktop', 'kubernetes'\)\)/u,
  );
  assert.match(migration, /environments_validate_provider_binding/u);
  assert.match(migration, /Environment provider connection is immutable/u);
  assert.match(migration, /environment_provider_connections_active_default_idx/u);
  assert.doesNotMatch(migration, /DROP COLUMN "fly_/u);
});

test("Fly backfill and mixed-version writes preserve both identity models", () => {
  assert.match(migration, /slice-2-fly-backfill/u);
  assert.match(migration, /legacy_backfill/u);
  assert.match(migration, /legacy_dual_write/u);
  assert.match(migration, /environments_bind_fly_provider/u);
  assert.match(migration, /environments_sync_fly_provider_resources/u);
  assert.match(migration, /environment_workspaces_sync_fly_provider_resources/u);
  assert.match(migration, /ON CONFLICT \("environment_id", "resource_role"\)/u);
  assert.match(migration, /ON CONFLICT \("workspace_id", "resource_role"\)/u);
  assert.match(migration, /2026-08-kubernetes-byoc-slice-2/u);
  assert.match(migration, /legacyColumnsRetained', true/u);
});

test("Connector commands have durable lease, replay, and operation linkage", () => {
  assert.match(migration, /"claim_token_hash" text/u);
  assert.match(migration, /"claim_expires_at" timestamp with time zone/u);
  assert.match(migration, /"event_cursor" integer DEFAULT 0 NOT NULL/u);
  assert.match(migration, /infrastructure_connector_commands_idempotency_idx/u);
  assert.match(migration, /infrastructure_connector_command_events_sequence_idx/u);
  assert.match(migration, /ADD COLUMN "connector_command_id" text/u);
  assert.match(migration, /environment_operations_connector_command_id_fk/u);
  assert.match(journal, /0076_kubernetes_byoc_persistence/u);
});
