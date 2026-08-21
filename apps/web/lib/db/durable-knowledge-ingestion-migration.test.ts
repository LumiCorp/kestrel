import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0079_durable_knowledge_ingestion.sql"),
  "utf8",
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8",
);

test("durable Knowledge ingestion keeps one nonterminal run per document", () => {
  assert.match(migration, /PARTITION BY "document_id"/u);
  assert.match(
    migration,
    /CASE WHEN "status" = 'running' THEN 0 ELSE 1 END/u,
  );
  assert.match(migration, /ranked\."rank" > 1/u);
  assert.match(migration, /KNOWLEDGE_INGESTION_RUN_SUPERSEDED/u);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "knowledge_ingestion_runs_active_document_idx"/u,
  );
  assert.match(migration, /WHERE "status" IN \('queued', 'running'\)/u);
  assert.match(journal, /"tag": "0079_durable_knowledge_ingestion"/u);
});
