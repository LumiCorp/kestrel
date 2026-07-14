import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0023_durable_thread_turns.sql"
  ),
  "utf8"
);
const approvalInputExpansion = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0027_durable_turn_approval_input_expand.sql"
  ),
  "utf8"
);
const journal = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/meta/_journal.json"
  ),
  "utf8"
);
const workerDockerfile = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../deploy/fly/kestrel-one-turn-worker/Dockerfile"
  ),
  "utf8"
);
const workerEntrypoint = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../scripts/turn-worker.ts"
  ),
  "utf8"
);
const webPackage = JSON.parse(
  fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../package.json"
    ),
    "utf8"
  )
) as { type?: string; scripts: Record<string, string> };

test("durable turns establish the shared queue and replay ledger", () => {
  for (const table of [
    "thread_turns",
    "thread_turn_events",
    "thread_turn_queue_state",
    "mobile_device_registrations",
    "mobile_push_deliveries",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`, "u"));
  }

  assert.match(migration, /thread_turns_thread_idempotency_idx/u);
  assert.match(migration, /thread_turns_thread_sequence_idx/u);
  assert.match(migration, /thread_turn_events_turn_sequence_idx/u);
  assert.match(migration, /DEFAULT now\(\) \+ interval '7 days'/u);
});

test("durable turns pin context, authorship, and terminal state invariants", () => {
  assert.match(migration, /thread_turns_context_revision_id_fk/u);
  assert.match(migration, /thread_turns_author_user_id_fk/u);
  assert.match(migration, /thread_turns_input_message_id_fk/u);
  assert.match(migration, /thread_messages_turn_id_fk/u);
  assert.match(migration, /thread_turns_terminal_timestamp_check/u);
  assert.match(approvalInputExpansion, /thread_turns_input_contract_check/u);
  assert.match(approvalInputExpansion, /"approval_id" text/u);
  assert.match(approvalInputExpansion, /"approval_approved" boolean/u);
  assert.match(migration, /thread_turn_queue_state_pause_reason_check/u);
});

test("mobile registrations remain user-owned and platform bounded", () => {
  assert.match(migration, /mobile_device_registrations_user_id_fk/u);
  assert.match(migration, /ON DELETE cascade/u);
  assert.match(migration, /CHECK \("platform" IN \('ios', 'android'\)\)/u);
  assert.match(migration, /mobile_device_registrations_push_token_idx/u);
  assert.match(migration, /mobile_push_deliveries_turn_device_kind_idx/u);
  assert.match(migration, /mobile_push_deliveries_status_check/u);
});

test("durable turn migration is registered with the unified migrator", () => {
  assert.match(journal, /"tag": "0023_durable_thread_turns"/u);
});

test("the durable turn worker runs the web package as ESM", () => {
  assert.equal(webPackage.type, "module");
});

test("the production worker image retains its TypeScript runtime toolchain", () => {
  assert.match(
    workerDockerfile,
    /pnpm install --frozen-lockfile --prod=false/u
  );
  assert.match(workerDockerfile, /"worker:turns"/u);
});

test("the production worker entrypoint starts without top-level await", () => {
  assert.doesNotMatch(
    workerEntrypoint,
    /\nawait\s+startDurableThreadTurnWorker\(\);/u
  );
  assert.match(workerEntrypoint, /void main\(\)\.catch/u);
  assert.equal(
    webPackage.scripts["worker:turns"],
    "node --conditions=react-server --import tsx scripts/turn-worker.ts"
  );
});
