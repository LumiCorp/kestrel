import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0032_apps_provider_connection_contract.sql"),
  "utf8"
);

test("provider connection migration adds hybrid and optional connection contracts", () => {
  assert.match(migration, /ADD COLUMN "connection_requirement"/u);
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS "app_definitions_connection_model_check"/u
  );
  assert.match(migration, /'none', 'personal', 'environment', 'hybrid'/u);
  assert.match(migration, /'none', 'optional', 'required'/u);
  assert.match(migration, /WHERE "key" = 'built_in\.weather'/u);
  assert.match(
    migration,
    /\("connection_model" = 'none'\) = \("connection_requirement" = 'none'\)/u
  );
});
