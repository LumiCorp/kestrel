import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0078_universal_thread_attachments.sql",
  ),
  "utf8",
);

test("unified files separate immutable blobs, stable identity, scopes, and message order", () => {
  assert.match(migration, /CREATE TABLE "file_blobs"/u);
  assert.match(migration, /CREATE TABLE "kestrel_files"/u);
  assert.match(migration, /CREATE TABLE "file_scope_grants"/u);
  assert.match(migration, /CREATE TABLE "file_representations"/u);
  assert.match(migration, /CREATE TABLE "thread_message_files"/u);
  assert.match(migration, /"size_bytes" BETWEEN 0 AND 104857600/u);
  assert.match(migration, /"sha256" IS NULL OR "sha256" ~ '\^\[a-f0-9\]\{64\}\$'/u);
  assert.match(migration, /PRIMARY KEY\("message_id", "file_id"\)/u);
  assert.match(migration, /"ordinal" BETWEEN 0 AND 19/u);
  assert.match(migration, /message_ordinal_idx/u);
  assert.doesNotMatch(migration, /'submitted'/u);
});

test("existing Knowledge rows become scoped Kestrel files without copying bytes", () => {
  assert.match(migration, /ALTER TABLE "knowledge_documents" ADD COLUMN "file_id"/u);
  assert.match(migration, /INSERT INTO "file_blobs"/u);
  assert.match(migration, /"storage_key"/u);
  assert.match(migration, /INSERT INTO "file_scope_grants"/u);
  assert.doesNotMatch(migration, /COPY\s/u);
});
