import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0098_hosted_browser_sessions.sql"),
  "utf8",
);
const schemaSource = fs.readFileSync(
  path.join(directory, "../../drizzle/schema.ts"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(path.join(directory, "migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<Record<string, unknown>> };
const historyLock = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/history-lock.json"),
    "utf8",
  ),
) as Record<string, string>;

test("hosted Browser sessions persist only the BrowserSessionV1 contract", () => {
  const sessionTable = migration.slice(
    migration.indexOf('CREATE TABLE "browser_sessions"'),
    migration.indexOf('--> statement-breakpoint'),
  );
  for (const column of [
    "session_id",
    "version",
    "thread_id",
    "mode",
    "state",
    "engine_revision",
    "generation",
    "effective_allowlist_revision",
    "created_at",
    "updated_at",
    "last_activity_at",
    "idle_expires_at",
    "hard_expires_at",
    "terminal_reason",
  ]) {
    assert.match(sessionTable, new RegExp(`"${column}"`, "u"));
  }
  assert.doesNotMatch(
    sessionTable,
    /organization_id|environment_id|project_id|user_id|run_id|machine_id/u,
  );
  assert.match(migration, /browser_sessions_one_nonterminal_per_thread_idx/u);
});

test("provider identity is isolated from the model-visible session row", () => {
  assert.match(migration, /CREATE TABLE "browser_session_resources"/u);
  assert.match(migration, /"originating_turn_id" text NOT NULL/u);
  assert.match(migration, /"machine_id" text NOT NULL/u);
  assert.match(migration, /"worker_image_digest" text NOT NULL/u);
  assert.match(migration, /ON DELETE RESTRICT/u);
  assert.match(schemaSource, /export const browserSessions = pgTable/u);
  assert.match(schemaSource, /export const browserSessionResources = pgTable/u);
});

test("hosted Browser session migration is registered and history locked", () => {
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0098_hosted_browser_sessions",
    ),
    {
      idx: 98,
      version: "7",
      when: 1_787_958_000_000,
      tag: "0098_hosted_browser_sessions",
      breakpoints: true,
    },
  );
  assert.equal(
    historyLock["0098_hosted_browser_sessions"],
    `1787958000000:${createHash("sha256").update(migration).digest("hex")}`,
  );
});
