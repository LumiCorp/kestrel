import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrations = path.resolve(import.meta.dirname, "migrations");
const migration = fs.readFileSync(
  path.join(migrations, "0081_knowledge_document_file_ownership.sql"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> };
const historyLock = JSON.parse(
  fs.readFileSync(path.join(migrations, "meta/history-lock.json"), "utf8"),
) as Record<string, string>;

test("Knowledge document ownership migration is registered last", () => {
  const entry = journal.entries.at(-1);
  assert.deepEqual(entry, {
    idx: 81,
    version: "7",
    when: 1_787_613_576_000,
    tag: "0081_knowledge_document_file_ownership",
    breakpoints: true,
  });
  assert.equal(
    historyLock["0081_knowledge_document_file_ownership"],
    `1787613576000:${createHash("sha256").update(migration).digest("hex")}`,
  );
});

test("Knowledge ownership remains file-scoped while content indexes become non-unique", () => {
  assert.match(migration, /DROP INDEX IF EXISTS "knowledge_documents_org_checksum_idx"/u);
  assert.match(migration, /DROP INDEX IF EXISTS "knowledge_documents_project_checksum_idx"/u);
  assert.match(migration, /DROP INDEX IF EXISTS "knowledge_documents_storage_key_idx"/u);
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX/u);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|DROP COLUMN/u);
});
