import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrations = path.resolve(import.meta.dirname, "migrations");
const migrationPath = path.join(migrations, "0080_file_blob_availability.sql");
const migration = fs.readFileSync(migrationPath, "utf8");
const journal = JSON.parse(
  fs.readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};
const historyLock = JSON.parse(
  fs.readFileSync(path.join(migrations, "meta/history-lock.json"), "utf8"),
) as Record<string, string>;

test("file blob availability migration is registered as the next applied migration", () => {
  const index = journal.entries.findIndex(
    (entry) => entry.tag === "0080_file_blob_availability",
  );

  assert.equal(index, journal.entries.length - 1);
  assert.deepEqual(journal.entries[index], {
    idx: 80,
    version: "7",
    when: 1_787_446_800_000,
    tag: "0080_file_blob_availability",
    breakpoints: true,
  });
  assert.equal(
    historyLock["0080_file_blob_availability"],
    `1787446800000:${createHash("sha256").update(migration).digest("hex")}`,
  );
  assert.ok(journal.entries[index - 1]?.when < journal.entries[index].when);
});

test("file blob availability migration preserves existing rows and enforces the availability contract", () => {
  assert.match(
    migration,
    /ALTER TABLE "file_blobs"\s+ADD COLUMN "availability_status" text DEFAULT 'unknown' NOT NULL/u,
  );
  assert.match(
    migration,
    /ALTER TABLE "file_blobs"\s+ADD COLUMN "availability_checked_at" timestamp with time zone/u,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT "file_blobs_availability_check"\s+CHECK \("availability_status" IN \('unknown', 'available', 'missing'\)\)/u,
  );
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|DROP COLUMN/u);
});
