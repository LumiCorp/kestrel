import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("Environment Runtime Channel registration, canary, promotion, and rollback are atomic", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  const [{ resetDbRuntimeForTests }, runtime, processRuntime] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./runtime-channel"),
    import("./process-runtime"),
  ]);
  const pool = postgres(databaseUrl, { max: 1 });
  const connection = await pool.reserve();
  const suffix = crypto.randomUUID();
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
      await connection`
        UPDATE environment_runtime_channels SET
          current_version_id = ${savedChannel.currentVersionId},
          previous_version_id = ${savedChannel.previousVersionId},
          canary_environment_id = ${savedChannel.canaryEnvironmentId},
          generation = ${savedChannel.generation},
          last_github_run_id = ${savedChannel.lastGithubRunId},
          last_github_run_attempt = ${savedChannel.lastGithubRunAttempt},
          updated_at = ${savedChannel.updatedAt}
        WHERE name = 'production'
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
    runtimeImage: runtimeImage(suffix, "runtime-b"),
    runtimeSourceRevision: revisionB,
    routerImage: routerImage(suffix, "router-b"),
    routerSourceRevision: revisionB,
    githubRunId: "1002",
    githubRunAttempt: 1,
  });
  const third = await register(runtime, {
    runtimeImage: runtimeImage(suffix, "runtime-c"),
    runtimeSourceRevision: revisionC,
    routerImage: routerImage(suffix, "router-c"),
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
      canary_environment_id = ${environmentId},
      generation = ${generation},
      last_github_run_id = '1001',
      last_github_run_attempt = 1,
      updated_at = now()
    WHERE name = 'production'
  `;

  const requested = await runtime.requestEnvironmentRuntimeCanary({
    runtimeVersionId: proposed.id,
  });
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
      error.code === "RUNTIME_UPDATE_CONFLICT",
  );
  await connection`
    UPDATE environment_operations SET
      status = 'failed', stage = 'environment.activation.failed',
      error_code = 'TEST_FAILURE', error_message = 'retry me',
      completed_at = now(), updated_at = now()
    WHERE id = ${requested.operation.id}
  `;
  const retried = await runtime.requestEnvironmentRuntimeCanary({
    runtimeVersionId: proposed.id,
  });
  assert.equal(retried.operation.id, requested.operation.id);
  assert.equal(retried.operation.status, "queued");
  assert.equal(retried.operation.errorCode, null);
  await completeCanary(connection, {
    operationId: requested.operation.id,
    environmentId,
    version: proposed,
  });
  const promoted = await runtime.promoteEnvironmentRuntimeVersion({
    runtimeVersionId: proposed.id,
    expectedCurrentVersionId: initial.id,
    expectedGeneration: generation,
    canaryOperationId: requested.operation.id,
    githubRunId: "1002",
    githubRunAttempt: 1,
  });
  assert.equal(promoted.generation, generation + 1);
  assert.deepEqual(
    await runtime.promoteEnvironmentRuntimeVersion({
      runtimeVersionId: proposed.id,
      expectedCurrentVersionId: initial.id,
      expectedGeneration: generation,
      canaryOperationId: requested.operation.id,
      githubRunId: "1002",
      githubRunAttempt: 1,
    }),
    promoted,
  );
  let channel = await runtime.getEnvironmentRuntimeChannel();
  assert.equal(channel.currentVersion?.id, proposed.id);
  assert.equal(channel.previousVersion?.id, initial.id);

  await assert.rejects(
    runtime.promoteEnvironmentRuntimeVersion({
      runtimeVersionId: third.id,
      expectedCurrentVersionId: proposed.id,
      expectedGeneration: generation,
      canaryOperationId: requested.operation.id,
      githubRunId: "1003",
      githubRunAttempt: 1,
    }),
    (error: unknown) =>
      error instanceof runtime.EnvironmentRuntimeChannelError &&
      error.code === "RUNTIME_VERSION_CONFLICT",
  );
  await assert.rejects(
    runtime.promoteEnvironmentRuntimeVersion({
      runtimeVersionId: third.id,
      expectedCurrentVersionId: initial.id,
      expectedGeneration: generation,
      canaryOperationId: requested.operation.id,
      githubRunId: "1003",
      githubRunAttempt: 1,
    }),
    (error: unknown) =>
      error instanceof runtime.EnvironmentRuntimeChannelError &&
      error.code === "RUNTIME_VERSION_CONFLICT",
  );
  await assert.rejects(
    runtime.promoteEnvironmentRuntimeVersion({
      runtimeVersionId: third.id,
      expectedCurrentVersionId: proposed.id,
      expectedGeneration: generation + 1,
      canaryOperationId: requested.operation.id,
      githubRunId: "1003",
      githubRunAttempt: 1,
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
      expectedCurrentVersionId: proposed.id,
      expectedGeneration: generation + 1,
      canaryOperationId: thirdCanary.operation.id,
      githubRunId: "1003",
      githubRunAttempt: 1,
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
  await runtime.promoteEnvironmentRuntimeVersion({
    runtimeVersionId: third.id,
    expectedCurrentVersionId: proposed.id,
    expectedGeneration: generation + 1,
    canaryOperationId: thirdCanary.operation.id,
    githubRunId: "1003",
    githubRunAttempt: 1,
  });

  const rollbackCanary = await runtime.requestEnvironmentRuntimeCanary({
    runtimeVersionId: proposed.id,
  });
  await completeCanary(connection, {
    operationId: rollbackCanary.operation.id,
    environmentId,
    version: proposed,
  });
  await runtime.promoteEnvironmentRuntimeVersion({
    runtimeVersionId: proposed.id,
    expectedCurrentVersionId: third.id,
    expectedGeneration: generation + 2,
    canaryOperationId: rollbackCanary.operation.id,
    githubRunId: "1004",
    githubRunAttempt: 1,
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

function digest(suffix: string, role: string) {
  return createHash("sha256").update(`${suffix}:${role}`).digest("hex");
}
