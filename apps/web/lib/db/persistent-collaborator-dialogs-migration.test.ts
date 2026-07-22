import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(path.join(root, "migrations/0039_persistent_collaborator_dialogs.sql"), "utf8");
const journal = fs.readFileSync(path.join(root, "migrations/meta/_journal.json"), "utf8");

contractTest("web.hermetic", "collaborator dialogs and messages have durable thread identities", () => {
  assert.match(migration, /CREATE TABLE "thread_dialogs"/u);
  assert.match(migration, /FOREIGN KEY \("thread_id"\).*ON DELETE cascade/u);
  assert.match(migration, /ADD COLUMN "dialog_message_id" text/u);
  assert.match(migration, /CREATE UNIQUE INDEX "thread_messages_dialog_message_idx"/u);
  assert.match(migration, /CREATE UNIQUE INDEX "thread_dialogs_open_name_idx".*lower\("name"\).*WHERE "status" = 'open'/u);
  assert.match(journal, /"tag": "0039_persistent_collaborator_dialogs"/u);
});
