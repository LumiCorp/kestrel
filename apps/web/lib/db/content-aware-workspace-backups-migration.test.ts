import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "./migrations/0060_content_aware_workspace_backups.sql",
  import.meta.url,
);

test("content-aware backup migration preserves recovery and lifecycle invariants", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /CREATE TABLE "workspace_backup_protections"/u);
  assert.match(
    migration,
    /SELECT "id" \|\| ':legacy', "id", "reason", "created_at", "expires_at"[\s\S]*WHERE "status" = 'available'/u,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "workspace_backups_active_revision_idx"[\s\S]*\("workspace_id", "source_revision"\)[\s\S]*"source_revision" IS NOT NULL/u,
  );
  assert.match(migration, /'deleting', 'delete_failed'/u);
  assert.match(migration, /CREATE TABLE "release_controller_heartbeats"/u);
  assert.match(migration, /"contract_revision" integer NOT NULL/u);
});
