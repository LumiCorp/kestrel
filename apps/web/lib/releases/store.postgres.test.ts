import assert from "node:assert/strict";
import postgres from "postgres";
import test from "node:test";
import "../../scripts/register-server-only.mjs";
import {
  ROLE_IMAGE_REPOSITORIES,
  type FlyImageReleaseManifestV3,
  type FlyImageRole,
} from "./contracts";
import { RELEASE_CONTROLLER_CONTRACT_REVISION } from "./controller-contract";
import {
  RELEASE_MIGRATION_HEAD,
  RELEASE_MIGRATION_HISTORY_LOCK_HASH,
} from "./migration-identity";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();
const revision = "a".repeat(40);
const controllerImage = `registry.fly.io/kestrel-one-control-worker@sha256:${"9".repeat(64)}`;
const controllerFingerprint = `sha256:${"8".repeat(64)}`;
const roles: FlyImageRole[] = [
  "workspace-runtime",
  "environment-router",
  "preview-edge",
  "turn-worker",
  "runpod-worker",
];

test("v3 release attempts serialize publication and require exact preparation proof", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");
  const previousRevision = process.env.KESTREL_BUILD_REVISION;
  process.env.KESTREL_BUILD_REVISION = revision;
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
  const now = new Date();

  context.after(async () => {
    await sql`
      UPDATE fly_image_release_settings
      SET stable_release_id = NULL, active_release_id = NULL,
          canary_environment_id = NULL, updated_at = now()
      WHERE id = 'platform'
    `;
    await sql`DELETE FROM fly_image_release_targets WHERE release_id IN (SELECT id FROM fly_image_releases WHERE bundle_revision = ${revision})`;
    await sql`DELETE FROM fly_image_release_components WHERE release_id IN (SELECT id FROM fly_image_releases WHERE bundle_revision = ${revision})`;
    await sql`DELETE FROM fly_image_releases WHERE bundle_revision = ${revision}`;
    await sql`DELETE FROM fly_image_release_attempts WHERE source_revision = ${revision}`;
    await sql`DELETE FROM fly_image_releases WHERE id = ${stableId}`;
    await sql`DELETE FROM release_controller_heartbeats WHERE id = 'platform'`;
    await sql`DELETE FROM environments WHERE id = ${environmentId}`;
    await sql`DELETE FROM organization WHERE id = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE id = ${userId}`;
    if (previousRevision === undefined)
      Reflect.deleteProperty(process.env, "KESTREL_BUILD_REVISION");
    else process.env.KESTREL_BUILD_REVISION = previousRevision;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      VALUES (${userId}, 'Release User', ${`${userId}@example.test`}, true, ${now}, ${now})
    `;
    await transaction`
      INSERT INTO organization (id, name, slug, "createdAt")
      VALUES (${organizationId}, 'Release Org', ${`release-org-${suffix}`}, ${now})
    `;
    await transaction`
      INSERT INTO environments (
        id, organization_id, created_by_user_id, name, slug, provider, region,
        status, fly_app_name, router_url
      ) VALUES (
        ${environmentId}, ${organizationId}, ${userId}, 'Release Canary',
        ${`release-canary-${suffix}`}, 'fly', 'iad', 'ready',
        ${`release-canary-${suffix}`}, 'https://router.example.test'
      )
    `;
    await transaction`
      INSERT INTO "fly_image_releases" (
        "id", "bundle_revision", "manifest_digest", "trigger", "status",
        "validation", "created_at", "updated_at"
      ) VALUES (
        ${stableId}, ${"c".repeat(40)}, ${`sha256:${"c".repeat(64)}`},
        'manual', 'completed',
        ${transaction.json({ status: "passed", commands: ["seed"], completedAt: now.toISOString() })},
        ${now}, ${now}
      )
    `;
    for (const [index, role] of roles.entries()) {
      await transaction`
        INSERT INTO "fly_image_release_components" (
          "release_id", "role", "image", "source_revision",
          "input_fingerprint", "configuration_contract_fingerprint",
          "changed", "smoke", "environment_gateway_accepted_versions"
        ) VALUES (
          ${stableId}, ${role},
          ${`${ROLE_IMAGE_REPOSITORIES[role]}@sha256:${String(index + 1).repeat(64)}`},
          ${"c".repeat(40)}, ${`sha256:${String(index + 5).repeat(64)}`},
          ${role === "turn-worker" ? `sha256:${"e".repeat(64)}` : null},
          false,
          ${transaction.json({ status: "passed", command: `stable ${role}`, completedAt: now.toISOString() })},
          ${role === "environment-router" ? transaction.array([2, 3]) : null}::integer[]
        )
      `;
    }
    await transaction`
      UPDATE fly_image_release_settings
      SET stable_release_id = ${stableId}, active_release_id = NULL,
          canary_environment_id = ${environmentId}, updated_at = ${now}
      WHERE id = 'platform'
    `;
  });

  const attempt = await releases.acquireFlyImageReleaseAttempt({
    sourceRevision: revision,
    trigger: "manual",
    forceAll: true,
    githubRunId: "1001",
    githubRunAttempt: 1,
  });
  assert.equal(
    (
      await releases.acquireFlyImageReleaseAttempt({
        sourceRevision: revision,
        trigger: "manual",
        forceAll: true,
        githubRunId: "1001",
        githubRunAttempt: 1,
      })
    ).id,
    attempt.id,
  );
  await assert.rejects(
    releases.acquireFlyImageReleaseAttempt({
      sourceRevision: revision,
      trigger: "manual",
      forceAll: true,
      githubRunId: "1002",
      githubRunAttempt: 1,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "RELEASE_ATTEMPT_ACTIVE",
  );
  await assert.rejects(
    releases.renewFlyImageReleaseAttempt({
      attemptId: attempt.id,
      sourceRevision: revision,
      githubRunId: "9999",
      githubRunAttempt: 1,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "RELEASE_ATTEMPT_INVALID",
  );
  await releases.renewFlyImageReleaseAttempt({
    attemptId: attempt.id,
    sourceRevision: revision,
    githubRunId: "1001",
    githubRunAttempt: 1,
  });
  const candidate = await releases.registerFlyImageReleaseCandidate(
    manifestFor(attempt.id, now),
  );
  const listedCandidate = (await releases.listFlyImageReleases()).releases.find(
    (release) => release.id === candidate.id,
  );
  assert.equal(
    listedCandidate?.turnWorkerConfigurationAcknowledgementRequired,
    true,
  );
  const preparation = await releases.getFlyImageReleasePreparation(
    candidate.id,
  );
  assert.equal("runtimeImages" in preparation, false);
  await assert.rejects(
    releases.acknowledgeFlyImageReleaseMigration({
      releaseId: candidate.id,
      actorUserId: userId,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "RELEASE_STATE_INVALID",
  );

  await sql`
    INSERT INTO release_controller_heartbeats (
      id, contract_revision, source_revision, image, input_fingerprint,
      machine_id, heartbeat_at, started_at
    ) VALUES (
      'platform', ${RELEASE_CONTROLLER_CONTRACT_REVISION}, ${revision},
      ${controllerImage}, ${controllerFingerprint}, 'controller-machine', ${now}, ${now}
    )
    ON CONFLICT (id) DO UPDATE SET
      contract_revision = excluded.contract_revision,
      source_revision = excluded.source_revision,
      image = excluded.image,
      input_fingerprint = excluded.input_fingerprint,
      machine_id = excluded.machine_id,
      heartbeat_at = excluded.heartbeat_at,
      started_at = excluded.started_at
  `;
  const prepared = await releases.completeFlyImageReleasePreparation(
    candidate.id,
  );
  assert.ok(prepared.controllerPreparedAt);
  assert.ok(prepared.migrationVerifiedAt);
  const acknowledged = await releases.acknowledgeFlyImageReleaseMigration({
    releaseId: candidate.id,
    actorUserId: userId,
  });
  assert.ok(acknowledged.migrationApprovedAt);
  await sql`
    UPDATE fly_image_releases
    SET migration_expected_history_lock_hash = ${`sha256:${"0".repeat(64)}`}
    WHERE id = ${candidate.id}
  `;
  await assert.rejects(
    releases.approveFlyImageRelease({
      releaseId: candidate.id,
      actorUserId: userId,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "RELEASE_MIGRATION_BLOCKED",
  );
  await sql`
    UPDATE fly_image_releases
    SET migration_expected_history_lock_hash = ${RELEASE_MIGRATION_HISTORY_LOCK_HASH}
    WHERE id = ${candidate.id}
  `;
  await assert.rejects(
    releases.approveFlyImageRelease({
      releaseId: candidate.id,
      actorUserId: userId,
    }),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "RELEASE_TURN_WORKER_CONFIG_BLOCKED",
  );
  const configurationAcknowledged =
    await releases.acknowledgeTurnWorkerConfiguration({
      releaseId: candidate.id,
      actorUserId: userId,
    });
  assert.ok(configurationAcknowledged?.turnWorkerConfigurationApprovedAt);
  const approved = await releases.approveFlyImageRelease({
    releaseId: candidate.id,
    actorUserId: userId,
  });
  assert.equal(approved?.status, "approved");

  const failedAttempt = await releases.acquireFlyImageReleaseAttempt({
    sourceRevision: revision,
    trigger: "manual",
    forceAll: true,
    githubRunId: "1002",
    githubRunAttempt: 1,
  });
  assert.equal(
    await releases.failFlyImageReleaseAttempt({
      attemptId: failedAttempt.id,
      sourceRevision: revision,
      githubRunId: "9999",
      githubRunAttempt: 1,
      evidence: { message: "wrong run must not settle attempt" },
    }),
    null,
  );
  await releases.failFlyImageReleaseAttempt({
    attemptId: failedAttempt.id,
    sourceRevision: revision,
    githubRunId: "1002",
    githubRunAttempt: 1,
    evidence: { message: "publication failed" },
  });
  await assert.rejects(
    releases.registerFlyImageReleaseCandidate(
      manifestFor(failedAttempt.id, now, "1002"),
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "RELEASE_ATTEMPT_INVALID",
  );

  const settledAttempt = await releases.acquireFlyImageReleaseAttempt({
    sourceRevision: revision,
    trigger: "manual",
    forceAll: true,
    githubRunId: "1003",
    githubRunAttempt: 1,
  });
  const mismatchedManifest = manifestFor(settledAttempt.id, now, "1003");
  mismatchedManifest.attempt.forceAll = false;
  await assert.rejects(
    releases.registerFlyImageReleaseCandidate(mismatchedManifest),
    (error: unknown) =>
      (error as { code?: string }).code === "RELEASE_ATTEMPT_INVALID",
  );
  const settledCandidate = await releases.registerFlyImageReleaseCandidate(
    manifestFor(settledAttempt.id, now, "1003"),
  );
  assert.equal(
    (
      await releases.registerFlyImageReleaseCandidate(
        manifestFor(settledAttempt.id, now, "1003"),
      )
    ).id,
    settledCandidate.id,
  );
  const replayWithDifferentArtifact = manifestFor(
    settledAttempt.id,
    now,
    "1003",
  );
  replayWithDifferentArtifact.components[0]!.image = `${ROLE_IMAGE_REPOSITORIES[replayWithDifferentArtifact.components[0]!.role]}@sha256:${"f".repeat(64)}`;
  await assert.rejects(
    releases.registerFlyImageReleaseCandidate(replayWithDifferentArtifact),
    (error: unknown) =>
      (error as { code?: string }).code === "RELEASE_ATTEMPT_INVALID",
  );
  assert.equal(
    await releases.failFlyImageReleaseAttempt({
      attemptId: settledAttempt.id,
      sourceRevision: revision,
      githubRunId: "1003",
      githubRunAttempt: 1,
      evidence: { message: "ambiguous client timeout" },
    }),
    null,
  );
  assert.equal(settledCandidate.status, "candidate");

  await sql`
    UPDATE "fly_image_releases"
    SET "status" = 'paused', "failure_code" = 'TURN_WORKER_READINESS_TIMEOUT',
        "failure_message" = 'Candidate worker did not become ready',
        "updated_at" = now()
    WHERE "id" = ${candidate.id}
  `;
  const rollback = await releases.createFlyImageRollback({
    failedReleaseId: candidate.id,
    actorUserId: userId,
  });
  assert.equal(rollback?.status, "candidate");
  const [preparedState] = await sql`
    SELECT "active_release_id" FROM "fly_image_release_settings"
    WHERE "id" = 'platform'
  `;
  assert.equal(preparedState?.active_release_id, candidate.id);

  const listedRollback = (await releases.listFlyImageReleases()).releases.find(
    (release) => release.id === rollback?.id,
  );
  assert.equal(
    listedRollback?.turnWorkerConfigurationAcknowledgementRequired,
    true,
  );
  assert.equal(listedRollback?.recoveryEligibility.ok, false);
  assert.equal(
    listedRollback?.recoveryEligibility.code,
    "RELEASE_TURN_WORKER_CONFIG_BLOCKED",
  );
  await releases.acknowledgeTurnWorkerConfiguration({
    releaseId: rollback!.id,
    actorUserId: userId,
  });
  const activatedRollback = await releases.recoverFlyImageReleaseForward({
    releaseId: rollback!.id,
    actorUserId: userId,
  });
  assert.equal(activatedRollback?.status, "approved");
  assert.equal(activatedRollback?.recoveryOfReleaseId, candidate.id);
});

function manifestFor(
  attemptId: string,
  completedAt: Date,
  githubRunId = "1001",
): FlyImageReleaseManifestV3 {
  return {
    version: 3,
    attempt: {
      id: attemptId,
      githubRunId,
      githubRunAttempt: 1,
      forceAll: true,
    },
    controllerContractRevision: RELEASE_CONTROLLER_CONTRACT_REVISION,
    bundleRevision: revision,
    trigger: "manual",
    migration: {
      changed: true,
      head: RELEASE_MIGRATION_HEAD,
      historyLockHash: RELEASE_MIGRATION_HISTORY_LOCK_HASH,
    },
    controller: {
      role: "release-controller",
      image: controllerImage,
      sourceRevision: revision,
      inputFingerprint: controllerFingerprint,
      smoke: {
        status: "passed",
        command: "smoke release-controller",
        completedAt: completedAt.toISOString(),
      },
    },
    environmentGateway: { producedVersion: 3 },
    validation: {
      status: "passed",
      commands: ["pnpm validate"],
      completedAt: completedAt.toISOString(),
    },
    components: roles.map((role, index) => ({
      role,
      image: `${ROLE_IMAGE_REPOSITORIES[role]}@sha256:${String(index + 1).repeat(64)}`,
      sourceRevision: revision,
      inputFingerprint: `sha256:${String(index + 2).repeat(64)}`,
      smoke: {
        status: "passed",
        command: `smoke ${role}`,
        completedAt: completedAt.toISOString(),
      },
      ...(role === "environment-router"
        ? { environmentGateway: { acceptedVersions: [2, 3] } }
        : {}),
      ...(role === "turn-worker"
        ? { configurationContractFingerprint: `sha256:${"f".repeat(64)}` }
        : {}),
    })),
  };
}
