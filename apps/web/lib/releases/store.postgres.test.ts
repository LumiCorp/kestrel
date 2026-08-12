import assert from "node:assert/strict";
import postgres from "postgres";
import test from "node:test";
import "../../scripts/register-server-only.mjs";
import type { FlyImageReleaseManifestV2, FlyImageRole } from "./contracts";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();
const roles: Array<[FlyImageRole, string]> = [
  ["workspace-runtime", "kestrel-one-runner"],
  ["environment-router", "kestrel-one-runner"],
  ["preview-edge", "kestrel-preview-edge"],
  ["turn-worker", "kestrel-one-turn-worker"],
  ["runpod-worker", "kestrel-one-runpod-worker"],
];

test("release admission rejects stale publication and forward recovery atomically replaces a paused release", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");
  const liveRevision = "a".repeat(40);
  const previousBuildRevision = process.env.KESTREL_BUILD_REVISION;
  process.env.KESTREL_BUILD_REVISION = liveRevision;
  const [{ resetDbRuntimeForTests }, releases] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./store"),
  ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const userId = `release-user-${suffix}`;
  const organizationId = `release-org-${suffix}`;
  const environmentId = `release-environment-${suffix}`;
  const stableId = `release-stable-${suffix}`;
  const pausedId = `release-paused-${suffix}`;
  const now = new Date();

  context.after(async () => {
    await sql`
      UPDATE "fly_image_release_settings"
      SET "stable_release_id" = NULL, "active_release_id" = NULL,
          "canary_environment_id" = NULL, "updated_at" = now()
      WHERE "id" = 'platform'
    `;
    await sql`DELETE FROM "fly_image_releases" WHERE "id" IN (${stableId}, ${pausedId}) OR "bundle_revision" IN (${liveRevision}, ${"b".repeat(40)})`;
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
    if (previousBuildRevision === undefined) {
      Reflect.deleteProperty(process.env, "KESTREL_BUILD_REVISION");
    } else {
      process.env.KESTREL_BUILD_REVISION = previousBuildRevision;
    }
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      VALUES (${userId}, 'Release User', ${`${userId}@example.test`}, true, ${now}, ${now})
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${organizationId}, 'Release Org', ${`release-org-${suffix}`}, ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "provider", "region", "status", "fly_app_name", "router_url"
      ) VALUES (
        ${environmentId}, ${organizationId}, ${userId}, 'Release Canary',
        ${`release-canary-${suffix}`}, 'fly', 'iad', 'ready',
        ${`release-canary-${suffix}`}, 'https://router.example.test'
      )
    `;
    for (const [id, status, digest] of [
      [stableId, "completed", "c"],
      [pausedId, "paused", "d"],
    ] as const) {
      await transaction`
        INSERT INTO "fly_image_releases" (
          "id", "bundle_revision", "manifest_digest", "trigger", "status",
          "validation", "created_at", "updated_at"
        ) VALUES (
          ${id}, ${"c".repeat(40)}, ${`sha256:${digest.repeat(64)}`},
          'manual', ${status}, ${transaction.json({ status: "passed", commands: ["seed"], completedAt: now.toISOString() })},
          ${now}, ${now}
        )
      `;
    }
    await transaction`
      INSERT INTO "release_controller_heartbeats" (
        "id", "contract_revision", "heartbeat_at", "started_at"
      ) VALUES ('platform', 1, ${now}, ${now})
      ON CONFLICT ("id") DO UPDATE SET
        "contract_revision" = 1, "heartbeat_at" = ${now},
        "started_at" = ${now}
    `;
    await transaction`
      UPDATE "fly_image_release_settings"
      SET "stable_release_id" = ${stableId}, "active_release_id" = ${pausedId},
          "canary_environment_id" = ${environmentId}, "updated_at" = ${now}
      WHERE "id" = 'platform'
    `;
  });

  const manifest = manifestFor(liveRevision, now);
  const staleRevision = "b".repeat(40);
  await assert.rejects(
    releases.registerFlyImageReleaseCandidate({
      ...manifest,
      bundleRevision: staleRevision,
      components: manifest.components.map((component) => ({
        ...component,
        sourceRevision: staleRevision,
      })),
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "RELEASE_BUILD_REVISION_MISMATCH");
      return true;
    },
  );
  const [staleCount] = await sql`
    SELECT count(*)::int AS count FROM "fly_image_releases"
    WHERE "bundle_revision" = ${staleRevision}
  `;
  assert.equal(staleCount?.count, 0);

  const candidate = await releases.registerFlyImageReleaseCandidate(manifest);
  const recovered = await releases.recoverFlyImageReleaseForward({
    releaseId: candidate.id,
    actorUserId: userId,
  });
  assert.equal(recovered?.status, "approved");
  assert.equal(recovered?.recoveryOfReleaseId, pausedId);

  const [state] = await sql`
    SELECT settings.active_release_id, paused.status AS paused_status,
           candidate.recovery_of_release_id
    FROM "fly_image_release_settings" settings
    JOIN "fly_image_releases" paused ON paused.id = ${pausedId}
    JOIN "fly_image_releases" candidate ON candidate.id = ${candidate.id}
    WHERE settings.id = 'platform'
  `;
  assert.equal(state?.active_release_id, candidate.id);
  assert.equal(state?.paused_status, "superseded");
  assert.equal(state?.recovery_of_release_id, pausedId);
  const targets = await sql`
    SELECT "target_kind", "environment_id" FROM "fly_image_release_targets"
    WHERE "release_id" = ${candidate.id}
  `;
  assert.ok(
    targets.some(
      (target) =>
        target.target_kind === "environment" &&
        target.environment_id === environmentId,
    ),
  );
});

function manifestFor(
  revision: string,
  completedAt: Date,
): FlyImageReleaseManifestV2 {
  return {
    version: 2,
    controllerContractRevision: 1,
    bundleRevision: revision,
    trigger: "manual",
    migrationChanged: false,
    environmentGateway: { producedVersion: 3 },
    validation: {
      status: "passed",
      commands: ["pnpm validate"],
      completedAt: completedAt.toISOString(),
    },
    components: roles.map(([role, app], index) => ({
      role,
      image: `registry.fly.io/${app}@sha256:${String(index + 1).repeat(64)}`,
      sourceRevision: revision,
      inputFingerprint: `sha256:${String(index + 5).repeat(64)}`,
      smoke: {
        status: "passed",
        command: `smoke ${role}`,
        completedAt: completedAt.toISOString(),
      },
      ...(role === "environment-router"
        ? { environmentGateway: { acceptedVersions: [2, 3] } }
        : {}),
    })),
  };
}
