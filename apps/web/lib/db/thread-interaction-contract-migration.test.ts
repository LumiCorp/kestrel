import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0033_thread_interaction_contract.sql"),
  "utf8"
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8"
);

test("Thread interactions establish one durable request ledger", () => {
  assert.match(migration, /CREATE TABLE "thread_interactions"/u);
  assert.match(migration, /thread_interactions_request_idx/u);
  assert.match(migration, /thread_interactions_source_contract_check/u);
  assert.match(migration, /"assistant_message_id" text/u);
  assert.match(migration, /"resumed_at" timestamp with time zone/u);
});

test("existing hosted MCP checkpoints are projected into the shared ledger", () => {
  assert.match(migration, /FROM "mcp_interaction_checkpoints" checkpoint/u);
  assert.match(migration, /'mcp_sampling'/u);
  assert.match(migration, /'mcp_elicitation'/u);
  assert.match(migration, /JOIN "mcp_run_grants" run_grant/u);
  assert.doesNotMatch(migration, /JOIN "mcp_run_grants" grant/u);
  assert.match(migration, /ON CONFLICT \("request_id"\) DO NOTHING/u);
});

test("Thread interaction migration is registered", () => {
  assert.match(journal, /"tag": "0033_thread_interaction_contract"/u);
});
