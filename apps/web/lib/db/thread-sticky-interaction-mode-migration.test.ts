import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0043_thread_sticky_interaction_mode.sql"),
  "utf8",
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8",
);

contractTest("web.hermetic", "task interaction mode is sticky and backfilled from the latest durable turn", () => {
  assert.match(migration, /ADD COLUMN "interaction_mode" text DEFAULT 'chat' NOT NULL/u);
  assert.match(migration, /SELECT DISTINCT ON \("thread_id"\)/u);
  assert.match(migration, /ORDER BY "thread_id", "sequence" DESC/u);
  assert.match(migration, /SET "interaction_mode" = latest_turn\."requested_interaction_mode"/u);
  assert.match(migration, /CHECK \("interaction_mode" IN \('chat', 'plan', 'build'\)\)/u);
  assert.match(journal, /"tag": "0043_thread_sticky_interaction_mode"/u);
});
