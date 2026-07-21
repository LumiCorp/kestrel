import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0023_durable_thread_turns.sql"
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
const workerRuntime = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../turns/process-runtime.ts"
  ),
  "utf8"
);
const turnStore = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../turns/store.ts"
  ),
  "utf8"
);
const workerServerOnlyLoader = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../scripts/server-only-loader.mjs"
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

contractTest("web.hermetic", "durable turns establish the shared queue and replay ledger", () => {
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

contractTest("web.hermetic", "durable turns pin context, authorship, and terminal state invariants", () => {
  assert.match(migration, /thread_turns_context_revision_id_fk/u);
  assert.match(migration, /thread_turns_author_user_id_fk/u);
  assert.match(migration, /thread_turns_input_message_id_fk/u);
  assert.match(migration, /thread_messages_turn_id_fk/u);
  assert.match(migration, /thread_turns_terminal_timestamp_check/u);
  assert.match(migration, /thread_turns_input_contract_check/u);
  assert.match(migration, /"approval_id" text/u);
  assert.match(migration, /"approval_approved" boolean/u);
  assert.match(migration, /thread_turn_queue_state_pause_reason_check/u);
});

contractTest("web.hermetic", "mobile registrations remain user-owned and platform bounded", () => {
  assert.match(migration, /mobile_device_registrations_user_id_fk/u);
  assert.match(migration, /ON DELETE cascade/u);
  assert.match(migration, /CHECK \("platform" IN \('ios', 'android'\)\)/u);
  assert.match(migration, /mobile_device_registrations_push_token_idx/u);
  assert.match(migration, /mobile_push_deliveries_turn_device_kind_idx/u);
  assert.match(migration, /mobile_push_deliveries_status_check/u);
});

contractTest("web.hermetic", "durable turn migration is registered with the unified migrator", () => {
  assert.match(journal, /"tag": "0023_durable_thread_turns"/u);
});

contractTest("web.hermetic", "the durable turn worker runs the web package as ESM", () => {
  assert.equal(webPackage.type, "module");
});

contractTest("web.hermetic", "the production worker image retains its TypeScript runtime toolchain", () => {
  assert.match(
    workerDockerfile,
    /pnpm install --frozen-lockfile --prod=false/u
  );
  assert.match(workerDockerfile, /"worker:turns"/u);
});

contractTest("web.hermetic", "the production worker entrypoint starts without top-level await", () => {
  assert.doesNotMatch(
    workerEntrypoint,
    /\nawait\s+startDurableThreadTurnWorker\(\);/u
  );
  assert.match(workerEntrypoint, /void main\(\)\.catch/u);
  assert.equal(
    webPackage.scripts["worker:turns"],
    "node --import ./scripts/register-server-only.mjs --import tsx scripts/turn-worker.ts"
  );
  assert.doesNotMatch(webPackage.scripts["worker:turns"] ?? "", /react-server/u);
  assert.match(workerServerOnlyLoader, /specifier === "server-only"/u);
});

contractTest("web.hermetic", "the durable worker uses pinned organization context without request auth", () => {
  assert.doesNotMatch(workerRuntime, /@\/lib\/chat\/actions/u);
  assert.match(workerRuntime, /generateTitleForOrganization/u);
  assert.match(workerRuntime, /organizationId: turn\.organizationId/u);
});

contractTest("web.hermetic", "durable replay binds the cutoff through the timestamp column encoder", () => {
  assert.match(
    turnStore,
    /lte\(schema\.threadMessages\.createdAt, turn\.createdAt\)/u
  );
  assert.doesNotMatch(
    turnStore,
    /threadMessages\.createdAt\} <= \$\{turn\.createdAt/u
  );
});
