import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(
  path.join(import.meta.dirname, "migrations/0072_environment_runtime_channels.sql"),
  "utf8",
);

test("migration 0072 adds immutable runtime versions and one atomic production channel", () => {
  assert.match(migration, /CREATE TABLE "environment_runtime_versions"/u);
  assert.match(migration, /CREATE TABLE "environment_runtime_channels"/u);
  assert.match(migration, /UNIQUE \("workspace_runtime_image", "environment_router_image"\)/u);
  assert.match(migration, /"name" = 'production'/u);
  assert.match(migration, /"generation" >= 0/u);
  assert.match(
    migration,
    /workspace-runtime@sha256:\[0-9a-f\]\{64\}\$'/u,
  );
  assert.doesNotMatch(migration, /ghcr\\\\\.io/u);
  assert.match(migration, /fly_image_release_settings/u);
  assert.match(migration, /stable_release_id/u);
  assert.match(migration, /ON CONFLICT \("name"\) DO NOTHING/u);
});

test("migration 0072 is forward-only", () => {
  assert.doesNotMatch(
    migration,
    /^\s*(?:DROP\b|DELETE\s+FROM\b|TRUNCATE\b)/imu,
  );
});
