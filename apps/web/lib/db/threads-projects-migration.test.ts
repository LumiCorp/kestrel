import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0013_threads_projects.sql"
  ),
  "utf8"
);

test("Threads migration is a physical hard cutover with preserved IDs", () => {
  assert.match(migration, /ALTER TABLE "chats" RENAME TO "threads"/);
  assert.match(migration, /ALTER TABLE "messages" RENAME TO "thread_messages"/);
  assert.match(migration, /RENAME COLUMN "chat_id" TO "thread_id"/);
  assert.doesNotMatch(migration, /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i);
  assert.doesNotMatch(migration, /INSERT INTO "threads"[\s\S]*SELECT/i);
});

test("Threads migration backfills authorship, search text, and canonical foreign keys", () => {
  assert.match(migration, /SET "author_user_id" = t\."created_by_user_id"/);
  assert.match(migration, /SET "search_text" = COALESCE/);
  assert.match(migration, /CONSTRAINT "thread_messages_thread_fk"/);
  assert.match(
    migration,
    /CONSTRAINT "threads_created_by_user_fk"[\s\S]*ON DELETE set null/
  );
  assert.match(
    migration,
    /ALTER COLUMN "created_by_user_id" DROP NOT NULL/
  );
  assert.match(migration, /CONSTRAINT "artifact_documents_thread_fk"/);
  assert.match(migration, /CONSTRAINT "media_generation_jobs_thread_fk"/);
});

test("Projects migration establishes memberships and immutable context revisions", () => {
  assert.match(migration, /CREATE TABLE "project_members"/);
  assert.match(migration, /project_members_role_check/);
  assert.match(migration, /CREATE FUNCTION "enforce_project_has_owner"/);
  assert.match(migration, /projects_require_owner/);
  assert.match(migration, /project_members_require_owner/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/g);
  assert.match(
    migration,
    /TG_OP = 'UPDATE'[\s\S]*NEW\."project_id", OLD\."project_id"/
  );
  assert.match(migration, /CREATE TABLE "project_context_revisions"/);
  assert.match(migration, /project_context_revisions_project_revision_idx/);
  assert.match(migration, /CREATE TABLE "project_context_documents"/);
});
