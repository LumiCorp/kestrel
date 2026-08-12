import assert from "node:assert/strict";
import postgres from "postgres";
import test from "node:test";
import {
  inspectFlyReleaseDeploymentReadiness,
  inspectFlyReleaseCompatibilitySchema,
  LEGACY_RELEASE_COMPATIBILITY_BOOTSTRAP,
} from "./deployment-preflight";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("production preflight treats the pre-compatibility schema as legacy metadata", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const sql = postgres(databaseUrl, { max: 1 });
  const schemaName = `release_preflight_${crypto.randomUUID().replaceAll("-", "")}`;
  const schema = sql(schemaName);
  context.after(async () => {
    await sql`DROP SCHEMA IF EXISTS ${schema} CASCADE`;
    await sql.end({ timeout: 0 });
  });

  await sql`CREATE SCHEMA ${schema}`;
  await sql`
    CREATE TABLE ${schema}.fly_image_releases (
      id text PRIMARY KEY,
      status text NOT NULL
    )
  `;
  await sql`
    CREATE TABLE ${schema}.fly_image_release_components (
      release_id text NOT NULL,
      role text NOT NULL
    )
  `;
  await sql`
    CREATE TABLE ${schema}.fly_image_release_settings (
      id text PRIMARY KEY,
      stable_release_id text,
      active_release_id text
    )
  `;
  await sql`
    INSERT INTO ${schema}.fly_image_releases (id, status)
    VALUES ('stable', 'completed'), ('active', 'paused')
  `;
  await sql`
    INSERT INTO ${schema}.fly_image_release_components (release_id, role)
    VALUES ('stable', 'environment-router')
  `;
  await sql`
    INSERT INTO ${schema}.fly_image_release_settings (
      id, stable_release_id, active_release_id
    ) VALUES ('platform', 'stable', 'active')
  `;

  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
  assert.equal(
    (await inspectFlyReleaseCompatibilitySchema(scopedUrl.toString())).ready,
    false,
  );
  const result = await inspectFlyReleaseDeploymentReadiness({
    databaseUrl: scopedUrl.toString(),
    producedVersion: 3,
    bootstrap: LEGACY_RELEASE_COMPATIBILITY_BOOTSTRAP,
  });

  assert.equal(result.ready, true);
  if (result.ready) assert.equal(result.mode, "legacy_bridge");
});

test("production compatibility schema reports ready after migration", async () => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  assert.deepEqual(await inspectFlyReleaseCompatibilitySchema(databaseUrl), {
    ready: true,
    missingColumns: [],
  });
});
