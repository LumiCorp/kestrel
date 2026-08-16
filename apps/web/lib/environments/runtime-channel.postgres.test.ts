import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("Environment Runtime Channel registration, canary, promotion, and rollback are atomic", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  const [{ resetDbRuntimeForTests }, runtime, processRuntime, queue] =
    await Promise.all([
      import("@/lib/db/runtime"),
      import("./runtime-channel"),
      import("./process-runtime"),
      import("@/lib/knowledge/queue"),
    ]);
  const pool = postgres(databaseUrl, { max: 1 });
  const connection = await pool.reserve();
  const suffix = crypto.randomUUID();
  const productionRun = BigInt(`0x${suffix.replaceAll("-", "").slice(0, 15)}`);
  const userId = `runtime-user-${suffix}`;
  const organizationId = `runtime-org-${suffix}`;
  const environmentId = `runtime-environment-${suffix}`;
  const revisionA = "a".repeat(40);
  const revisionB = "b".repeat(40);
  const revisionC = "c".repeat(40);
  const now = new Date();
  await connection`
    SELECT pg_advisory_lock(hashtextextended('kestrel:test-environment-runtime-channel-fixture', 0))
  `;
  const [savedChannel] = await connection<
    Array<{
      currentVersionId: string | null;
      previousVersionId: string | null;
      desiredVersionId: string | null;
      canaryEnvironmentId: string | null;
      generation: number;
      lastGithubRunId: string | null;
      lastGithubRunAttempt: number | null;
      updatedAt: Date;
    }>
  >`
    SELECT
      current_version_id AS "currentVersionId",
      previous_version_id AS "previousVersionId",
      desired_version_id AS "desiredVersionId",
      canary_environment_id AS "canaryEnvironmentId",
      generation,
      last_github_run_id AS "lastGithubRunId",
      last_github_run_attempt AS "lastGithubRunAttempt",
      updated_at AS "updatedAt"
    FROM environment_runtime_channels
    WHERE name = 'production'
  `;
  assert.ok(savedChannel, "Migration 0072 must create the production channel");
  const createdVersionIds = new Set<string>();

  context.after(async () => {
    try {
      await queue.stopEnvironmentLifecycleWorker();
      await connection`
        UPDATE environment_runtime_channels SET
          current_version_id = ${savedChannel.currentVersionId},
          previous_version_id = ${savedChannel.previousVersionId},
          desired_version_id = ${savedChannel.desiredVersionId},
          canary_environment_id = ${savedChannel.canaryEnvironmentId},
          generation = ${savedChannel.generation},
          last_github_run_id = ${savedChannel.lastGithubRunId},
          last_github_run_attempt = ${savedChannel.lastGithubRunAttempt},
          updated_at = ${savedChannel.updatedAt}
        WHERE name = 'production'
      `;
      await connection`
        DELETE FROM pgboss.job
        WHERE data->>'operationId' IN (
          SELECT id FROM environment_operations
          WHERE environment_id = ${environmentId}
        )
      `;
      await connection`
        DELETE FROM environment_operations
        WHERE environment_id = ${environmentId}
      `;
      await connection`DELETE FROM environments WHERE id = ${environmentId}`;
      if (createdVersionIds.size > 0) {
        await connection`
          DELETE FROM environment_runtime_versions
          WHERE id = ANY(${connection.array([...createdVersionIds])}::text[])
            AND id IS DISTINCT FROM ${savedChannel.currentVersionId}
            AND id IS DISTINCT FROM ${savedChannel.previousVersionId}
        `;
      }
      await connection`DELETE FROM organization WHERE id = ${organizationId}`;
      await connection`DELETE FROM "user" WHERE id = ${userId}`;
    } finally {
      await connection`
        SELECT pg_advisory_unlock(hashtextextended('kestrel:test-environment-runtime-channel-fixture', 0))
      `;
      connection.release();
      await pool.end({ timeout: 0 });
      await resetDbRuntimeForTests();
    }
  });

  await connection`
    INSERT INTO "user" (
      id, name, email, "emailVerified", "createdAt", "updatedAt"
    ) VALUES (
      ${userId}, 'Runtime User', ${`${userId}@example.test`}, true, ${now}, ${now}
    )
  `;
  await connection`
    INSERT INTO organization (id, name, slug, "createdAt")
    VALUES (
      ${organizationId}, 'Runtime Org', ${`runtime-org-${suffix}`}, ${now}
    )
  `;

  const initial = await register(runtime, {
    runtimeImage: runtimeImage(suffix, "runtime-a"),
    runtimeSourceRevision: revisionA,
    routerImage: routerImage(suffix, "router-a"),
    routerSourceRevision: revisionA,
    githubRunId: "1001",
    githubRunAttempt: 1,
  });
  const proposed = await register(runtime, {
    runtimeImage: runtimeTag(productionRun),
    runtimeSourceRevision: revisionB,
    routerImage: routerTag(productionRun),
    routerSourceRevision: revisionB,
    githubRunId: "1002",
    githubRunAttempt: 1,
  });
  const third = await register(runtime, {
    runtimeImage: runtimeTag(productionRun + BigInt(1)),
    runtimeSourceRevision: revisionC,
    routerImage: routerTag(productionRun + BigInt(1)),
    routerSourceRevision: revisionC,
    githubRunId: "1003",
    githubRunAttempt: 1,
  });
  for (const version of [initial, proposed, third]) {
    createdVersionIds.add(version.id);
  }
  assert.equal(
    (
      await runtime.registerEnvironmentRuntimeVersion({
        runtimeImage: initial.runtimeImage,
        runtimeSourceRevision: revisionA,
        routerImage: initial.routerImage,
        routerSourceRevision: revisionA,
        githubRunId: "1001",
        githubRunAttempt: 2,
      })
    ).version.id,
    initial.id,
  );
  await assert.rejects(
    runtime.registerEnvironmentRuntimeVersion({
      runtimeImage: initial.runtimeImage,
      runtimeSourceRevision: revisionB,
      routerImage: initial.routerImage,
      routerSourceRevision: revisionA,
      githubRunId: "1004",
      githubRunAttempt: 1,
    }),
    (error: unknown) =>
      error instanceof runtime.EnvironmentRuntimeChannelError &&
      error.code === "RUNTIME_VERSION_METADATA_CONFLICT",
  );

  await connection`
    INSERT INTO environments (
      id, organization_id, created_by_user_id, name, slug, provider, region,
      status, fly_app_name, fly_gateway_machine_id, router_url,
      runtime_image, router_image
    ) VALUES (
      ${environmentId}, ${organizationId}, ${userId}, 'Runtime Canary',
      ${`runtime-canary-${suffix}`}, 'fly', 'iad', 'ready',
      ${`runtime-canary-${suffix}`}, ${`gateway-${suffix}`},
      'https://router.example.test', ${initial.runtimeImage}, ${initial.routerImage}
    )
  `;
  const generation = savedChannel.generation + 10;
  await connection`
    UPDATE environment_runtime_channels SET
      current_version_id = ${initial.id},
      previous_version_id = NULL,
      desired_version_id = NULL,
      canary_environment_id = ${environmentId},
      generation = ${generation},
      last_github_run_id = '1001',
      last_github_run_attempt = 1,
      updated_at = now()
    WHERE name = 'production'
  `;

  const desired = await selectDesired(runtime, proposed, true);
  assert.equal(desired.version.id, proposed.id);
  assert.equal(desired.alreadyCurrent, false);
  const cancelled = await selectDesired(runtime, initial);
  assert.equal(cancelled.alreadyCurrent, true);
  assert.equal(
    (await runtime.getEnvironmentRuntimeChannel()).desiredVersion,
    null,
  );
  await selectDesired(runtime, proposed, true);

  const initialReconciliation =
    await runtime.reconcileDesiredEnvironmentRuntime();
  assert.equal(initialReconciliation.status, "requested");
  const requestedOperation = await runtime.getEnvironmentRuntimeCanary(
    proposed.id,
  );
  assert.ok(requestedOperation);
  const [queuedJob] = await connection<Array<{ count: number }>>`
    SELECT count(*)::int AS count
    FROM pgboss.job
    WHERE name = 'environment.operation.controller-v1'
      AND data->>'operationId' = ${requestedOperation.id}
      AND state IN ('created', 'retry', 'active')
  `;
  assert.equal(queuedJob?.count, 1);
  const requested = { operation: requestedOperation };
  const repeated = await runtime.requestEnvironmentRuntimeCanary({
    runtimeVersionId: proposed.id,
  });
  assert.equal(repeated.operation.id, requested.operation.id);
  await connection`
    UPDATE environment_operations SET
      input = jsonb_set(input, '{runtimeImage}', to_jsonb(${initial.runtimeImage}::text))
    WHERE id = ${requested.operation.id}
  `;
  await assert.rejects(
    processRuntime.processEnvironmentOperation(requested.operation.id),
    /do not match the immutable Runtime Version/u,
  );
  await connection`
    UPDATE environment_operations SET
      input = jsonb_set(input, '{runtimeImage}', to_jsonb(${proposed.runtimeImage}::text))
    WHERE id = ${requested.operation.id}
  `;
  await assert.rejects(
    runtime.requestEnvironmentRuntimeCanary({ runtimeVersionId: third.id }),
    (error: unknown) =>
      error instanceof runtime.EnvironmentRuntimeChannelError &&
      error.code === "RUNTIME_VERSION_CONFLICT",
  );
  await connection`
    UPDATE environment_operations SET
      status = 'failed', stage = 'environment.activation.failed',
      error_code = 'TEST_FAILURE', error_message = 'retry me',
      completed_at = now(), updated_at = now()
    WHERE id = ${requested.operation.id}
  `;
  const failed = await runtime.reconcileDesiredEnvironmentRuntime();
  assert.equal(failed.status, "failed");
  const retriedRequest = await runtime.requestEnvironmentRuntimeCanary({
    runtimeVersionId: proposed.id,
  });
  assert.equal(retriedRequest.operation.id, requested.operation.id);
  const retriedOperation = await runtime.getEnvironmentRuntimeCanary(
    proposed.id,
  );
  assert.equal(retriedOperation?.status, "queued");
  assert.equal(retriedOperation?.errorCode, null);
  await completeCanary(connection, {
    operationId: requested.operation.id,
    environmentId,
    version: proposed,
  });
  await selectDesired(runtime, third, true);
  await assert.rejects(
    runtime.requestEnvironmentRuntimeCanary({ runtimeVersionId: proposed.id }),
    (error: unknown) =>
      error instanceof runtime.EnvironmentRuntimeChannelError &&
      error.code === "RUNTIME_VERSION_CONFLICT",
  );
  await assert.rejects(
    runtime.promoteEnvironmentRuntimeVersion({
      runtimeVersionId: proposed.id,
      canaryOperationId: requested.operation.id,
    }),
    (error: unknown) =>
      error instanceof runtime.EnvironmentRuntimeChannelError &&
      error.code === "RUNTIME_VERSION_CONFLICT",
  );
  const stale = await selectDesired(runtime, proposed, true);
  assert.equal(stale.stale, true);
  assert.equal(
    (await runtime.getEnvironmentRuntimeChannel()).desiredVersion?.id,
    third.id,
  );
  await selectDesired(runtime, proposed);
  const reselectedCanary = await runtime.requestEnvironmentRuntimeCanary({
    runtimeVersionId: proposed.id,
  });
  await completeCanary(connection, {
    operationId: reselectedCanary.operation.id,
    environmentId,
    version: proposed,
  });
  const reconciled = await runtime.reconcileDesiredEnvironmentRuntime();
  assert.equal(reconciled.status, "promoted");
  const promoted = { versionId: proposed.id, generation: generation + 1 };
  assert.deepEqual(
    await runtime.promoteEnvironmentRuntimeVersion({
      runtimeVersionId: proposed.id,
      canaryOperationId: reselectedCanary.operation.id,
    }),
    promoted,
  );
  let channel = await runtime.getEnvironmentRuntimeChannel();
  assert.equal(channel.currentVersion?.id, proposed.id);
  assert.equal(channel.previousVersion?.id, initial.id);

  await selectDesired(runtime, third, true);
  await assert.rejects(
    runtime.promoteEnvironmentRuntimeVersion({
      runtimeVersionId: third.id,
      canaryOperationId: requested.operation.id,
    }),
    (error: unknown) =>
      error instanceof runtime.EnvironmentRuntimeChannelError &&
      error.code === "RUNTIME_CANARY_INCOMPLETE",
  );

  const thirdCanary = await runtime.requestEnvironmentRuntimeCanary({
    runtimeVersionId: third.id,
  });
  await connection`
    UPDATE environment_operations SET
      status = 'completed', stage = 'environment.update.ready',
      completed_at = now(), updated_at = now()
    WHERE id = ${thirdCanary.operation.id}
  `;
  await assert.rejects(
    runtime.promoteEnvironmentRuntimeVersion({
      runtimeVersionId: third.id,
      canaryOperationId: thirdCanary.operation.id,
    }),
    (error: unknown) =>
      error instanceof runtime.EnvironmentRuntimeChannelError &&
      error.code === "RUNTIME_CANARY_MISMATCH",
  );
  await connection`
    UPDATE environments SET
      runtime_image = ${third.runtimeImage},
      router_image = ${third.routerImage},
      updated_at = now()
    WHERE id = ${environmentId}
  `;
  await connection`
    UPDATE environment_operations SET
      status = 'completed', stage = 'environment.update.recovery_required',
      completed_at = now(), updated_at = now()
    WHERE id = ${thirdCanary.operation.id}
  `;
  const recoveryRequired = await runtime.reconcileDesiredEnvironmentRuntime();
  assert.equal(recoveryRequired.status, "recovery_required");
  const recoveryRetry = await runtime.retryDesiredEnvironmentRuntime();
  assert.equal(recoveryRetry.operation.status, "queued");
  assert.notEqual(recoveryRetry.operation.id, thirdCanary.operation.id);
  await completeCanary(connection, {
    operationId: recoveryRetry.operation.id,
    environmentId,
    version: third,
  });
  await runtime.promoteEnvironmentRuntimeVersion({
    runtimeVersionId: third.id,
    canaryOperationId: recoveryRetry.operation.id,
  });

  const rollbackSelection = await runtime.selectPreviousEnvironmentRuntime();
  assert.equal(rollbackSelection.versionId, proposed.id);
  assert.equal(
    (await runtime.getEnvironmentRuntimeChannel()).desiredVersion?.id,
    proposed.id,
  );
  const rollbackCanary = await runtime.requestEnvironmentRuntimeCanary({
    runtimeVersionId: proposed.id,
  });
  await connection`
    UPDATE environment_operations SET
      status = 'failed', stage = 'environment.update.failed',
      error_code = 'TEST_FAILURE', error_message = 'select again',
      completed_at = now(), updated_at = now()
    WHERE id = ${rollbackCanary.operation.id}
  `;
  await runtime.selectPreviousEnvironmentRuntime();
  const freshRollbackCanary = await runtime.requestEnvironmentRuntimeCanary({
    runtimeVersionId: proposed.id,
  });
  assert.notEqual(
    freshRollbackCanary.operation.id,
    rollbackCanary.operation.id,
  );
  await completeCanary(connection, {
    operationId: freshRollbackCanary.operation.id,
    environmentId,
    version: proposed,
  });
  await runtime.promoteEnvironmentRuntimeVersion({
    runtimeVersionId: proposed.id,
    canaryOperationId: freshRollbackCanary.operation.id,
  });
  channel = await runtime.getEnvironmentRuntimeChannel();
  assert.equal(channel.currentVersion?.id, proposed.id);
  assert.equal(channel.previousVersion?.id, third.id);
  assert.equal(channel.generation, generation + 3);
});

type RuntimeModule = typeof import("./runtime-channel");
type Version = Awaited<
  ReturnType<RuntimeModule["registerEnvironmentRuntimeVersion"]>
>["version"];

async function register(
  runtime: RuntimeModule,
  input: Parameters<RuntimeModule["registerEnvironmentRuntimeVersion"]>[0],
) {
  return (await runtime.registerEnvironmentRuntimeVersion(input)).version;
}

async function selectDesired(
  runtime: RuntimeModule,
  version: Version,
  rejectStaleBuild = false,
) {
  return runtime.selectDesiredEnvironmentRuntime({
    runtimeImage: version.runtimeImage,
    runtimeSourceRevision: version.runtimeSourceRevision,
    routerImage: version.routerImage,
    routerSourceRevision: version.routerSourceRevision,
    githubRunId: version.githubRunId,
    githubRunAttempt: version.githubRunAttempt,
    rejectStaleBuild,
  });
}

async function completeCanary(
  sql: Awaited<ReturnType<postgres.Sql["reserve"]>>,
  input: { operationId: string; environmentId: string; version: Version },
) {
  await sql`
    UPDATE environments SET
      runtime_image = ${input.version.runtimeImage},
      router_image = ${input.version.routerImage},
      updated_at = now()
    WHERE id = ${input.environmentId}
  `;
  await sql`
    UPDATE environment_operations SET
      status = 'completed', stage = 'environment.update.ready',
      completed_at = now(), updated_at = now()
    WHERE id = ${input.operationId}
  `;
}

function runtimeImage(suffix: string, role: string) {
  return `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${digest(suffix, role)}`;
}

function routerImage(suffix: string, role: string) {
  return `ghcr.io/lumicorp/kestrel-environment-router@sha256:${digest(suffix, role)}`;
}

function runtimeTag(runNumber: bigint) {
  return `ghcr.io/lumicorp/kestrel-workspace-runtime:production-${runNumber}-1`;
}

function routerTag(runNumber: bigint) {
  return `ghcr.io/lumicorp/kestrel-environment-router:production-${runNumber}-1`;
}

function digest(suffix: string, role: string) {
  return createHash("sha256").update(`${suffix}:${role}`).digest("hex");
}
