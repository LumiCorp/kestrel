import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "migrations");
const migration = fs.readFileSync(
  path.join(root, "0058_fly_image_releases.sql"),
  "utf8",
);
const journal = fs.readFileSync(path.join(root, "meta/_journal.json"), "utf8");

test("Fly image releases persist bundles, components, targets, and singleton settings", () => {
  assert.match(journal, /0058_fly_image_releases/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "fly_image_releases"/u);
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS "fly_image_release_components"/u,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS "fly_image_release_targets"/u,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS "fly_image_release_settings"/u,
  );
  assert.match(migration, /ON CONFLICT \("id"\) DO NOTHING/u);
  assert.match(migration, /"migration_approved_at" timestamp with time zone/u);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM/u);
});
