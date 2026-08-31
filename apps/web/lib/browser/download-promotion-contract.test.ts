import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const webRoot = path.resolve(import.meta.dirname, "../..");
const schema = fs.readFileSync(path.join(webRoot, "drizzle/schema.ts"), "utf8");
const migration = fs.readFileSync(
  path.join(webRoot, "lib/db/migrations/0099_browser_download_promotions.sql"),
  "utf8",
);
const stagingMigration = fs.readFileSync(
  path.join(webRoot, "lib/db/migrations/0100_browser_download_staging.sql"),
  "utf8",
);
const journal = JSON.parse(fs.readFileSync(
  path.join(webRoot, "lib/db/migrations/meta/_journal.json"),
  "utf8",
)) as { entries: Array<{ tag: string }> };
const historyLock = JSON.parse(fs.readFileSync(
  path.join(webRoot, "lib/db/migrations/meta/history-lock.json"),
  "utf8",
)) as Record<string, string>;

test("Browser download promotion migration is additive and matches the exact result authority", () => {
  for (const field of [
    "operation_id",
    "organization_id",
    "thread_id",
    "session_id",
    "generation",
    "pending_download_id",
    "sha256",
    "effect_revision",
    "file_id",
  ]) {
    assert.match(migration, new RegExp(`"${field}"`, "u"));
  }
  assert.match(migration, /browser_download_promotions_quarantine_idx/u);
  assert.match(migration, /browser_download_promotions_effect_revision_check/u);
  assert.doesNotMatch(migration, /(?:^|\n)(?:DROP|DELETE|UPDATE|TRUNCATE)\s/u);
  assert.ok(journal.entries.some((entry) => entry.tag === "0099_browser_download_promotions"));
  assert.equal(
    historyLock["0099_browser_download_promotions"],
    `1787961600000:${createHash("sha256").update(migration).digest("hex")}`,
  );
  assert.match(schema, /export const browserDownloadPromotions = pgTable/u);
  assert.match(schema, /effectRevision: text\("effect_revision"\)\.notNull\(\)/u);
});

test("Browser download staging migration durably owns unreferenced objects", () => {
  for (const field of [
    "operation_id", "object_key", "state", "expires_at", "file_id",
  ]) assert.match(stagingMigration, new RegExp(`"${field}"`, "u"));
  assert.match(stagingMigration, /cleanup_pending/u);
  assert.match(stagingMigration, /browser_download_staged_objects_quarantine_idx/u);
  assert.doesNotMatch(stagingMigration, /(?:^|\n)(?:DROP|DELETE|UPDATE|TRUNCATE)\s/u);
  assert.ok(journal.entries.some((entry) => entry.tag === "0100_browser_download_staging"));
  assert.equal(
    historyLock["0100_browser_download_staging"],
    `1787965200000:${createHash("sha256").update(stagingMigration).digest("hex")}`,
  );
  assert.match(schema, /export const browserDownloadStagedObjects = pgTable/u);
});
