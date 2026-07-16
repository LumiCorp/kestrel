import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migration = fs.readFileSync(
  path.join(root, "lib/db/migrations/0036_mobile_v2_thread_experience.sql"),
  "utf8"
);

test("mobile v2 migration keeps queue, branch, activity, and read state durable", () => {
  assert.match(migration, /ADD COLUMN "queue_ordinal"/u);
  assert.match(migration, /ADD COLUMN "output_message_id"/u);
  assert.match(migration, /CREATE TABLE "thread_turn_presentations"/u);
  assert.match(migration, /CREATE TABLE "thread_read_states"/u);
  assert.match(migration, /parent_thread_id/u);
  assert.match(migration, /branch_anchor_message_id/u);
  assert.match(migration, /jsonb_array_length\("milestones"\) <= 8/u);
});

test("mobile v2 migration is journaled atomically", () => {
  const journal = fs.readFileSync(path.join(root, "lib/db/migrations/meta/_journal.json"), "utf8");
  assert.match(journal, /"tag": "0036_mobile_v2_thread_experience"/u);
});
