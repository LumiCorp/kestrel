import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "./migrations/0068_hydra_runtime_bindings.sql",
  import.meta.url,
);
const deliveryMigrationUrl = new URL(
  "./migrations/0069_hydra_runtime_delivery_ledger.sql",
  import.meta.url,
);
const correctnessMigrationUrl = new URL(
  "./migrations/0070_hydra_runtime_correctness.sql",
  import.meta.url,
);

test("Hydra migration preserves Kestrel behavior while binding every Thread", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /"runtime_id" text NOT NULL DEFAULT 'kestrel'/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "runtime_participants"/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "runtime_bindings"/u);
  assert.match(migration, /'binding:' \|\| "id"/u);
  assert.match(
    migration,
    /SET "runtime_binding_id" = 'binding:' \|\| "id"/u,
  );
  assert.match(migration, /'kestrel', 'codex', 'claude'/u);
});

test("Hydra delivery migration separates answered from native acknowledgement", async () => {
  const migration = await readFile(deliveryMigrationUrl, "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "runtime_interaction_deliveries"/u);
  assert.match(migration, /'pending', 'delivering', 'delivered', 'failed', 'expired'/u);
  assert.match(migration, /"idempotency_key" text NOT NULL/u);
  assert.match(migration, /"native_correlation" jsonb NOT NULL/u);
});

test("Hydra correctness migration persists native lifecycle and acknowledgement identity", async () => {
  const migration = await readFile(correctnessMigrationUrl, "utf8");
  assert.match(migration, /"native_session_state" text NOT NULL DEFAULT 'ready'/u);
  assert.match(migration, /"environment_id" text/u);
  assert.match(migration, /"selected_model_id" text/u);
  assert.match(migration, /"recovery_source_binding_id" text/u);
  assert.match(migration, /"recovery_source_turn_id" text/u);
  assert.match(migration, /runtime_bindings_recovery_source_loss_idx/u);
  assert.match(migration, /'uninitialized', 'ready', 'degraded', 'released'/u);
  assert.match(migration, /"acknowledgement_event_id" text/u);
  assert.match(migration, /runtime_interaction_deliveries_ack_event_idx/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "runtime_binding_release_outbox"/u);
  assert.match(migration, /"claim_token_hash" text/u);
  assert.match(migration, /"claim_expires_at" timestamp with time zone/u);
  assert.match(migration, /"claimed_at" timestamp with time zone/u);
  assert.match(migration, /runtime_binding_release_outbox_ack_event_idx/u);
  assert.match(migration, /runtime_binding_release_outbox_claim_idx/u);
  assert.match(migration, /"runtime_event_reconciliation_state" text/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "desktop_runtime_descriptor_probes"/u);
  assert.match(migration, /desktop_runtime_descriptor_probes_claim_idx/u);
  assert.match(migration, /desktop_runtime_descriptor_probes_ack_event_idx/u);
});
