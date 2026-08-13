import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(
  path.join(process.cwd(), "lib/db/migrations/0067_thread_workspace_mode.sql"),
  "utf8",
);

test("existing Threads migrate to legacy before primary becomes the default", () => {
  const add = migration.indexOf('ADD COLUMN IF NOT EXISTS "workspace_mode"');
  const backfill = migration.indexOf('SET "workspace_mode" = \'legacy\'');
  const defaultPrimary = migration.indexOf(
    'ALTER COLUMN "workspace_mode" SET DEFAULT \'primary\'',
  );
  assert.ok(add >= 0);
  assert.ok(backfill > add);
  assert.ok(defaultPrimary > backfill);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "workspace_base_ref" text/u);
});
