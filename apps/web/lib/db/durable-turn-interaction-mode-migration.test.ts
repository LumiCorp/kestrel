import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0038_durable_turn_interaction_mode.sql"),
  "utf8"
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8"
);

test("durable turns persist a validated interaction mode", () => {
  assert.match(migration, /ADD COLUMN "requested_interaction_mode" text/u);
  assert.match(migration, /DEFAULT 'chat' NOT NULL/u);
  assert.match(
    migration,
    /CHECK \("requested_interaction_mode" IN \('chat', 'plan', 'build'\)\)/u
  );
  assert.match(journal, /"tag": "0038_durable_turn_interaction_mode"/u);
});
