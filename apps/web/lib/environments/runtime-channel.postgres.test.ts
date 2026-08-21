import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("manual runtime activation changes only the exact canary and channel pointers", async (context) => {
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
  const userId = `manual-runtime-user-${suffix}`;
  const organizationId = `manual-runtime-org-${suffix}`;
  const canaryId = `manual-runtime-canary-${suffix}`;
  const siblingId = `manual-runtime-sibling-${suffix}`;
  const now = new Date();
  await connection`
    SELECT pg_advisory_lock(hashtextextended('kestrel:test-environment-runtime-channel-fixture', 0))
  `;
  const [savedChannel] = await connection<
    Array<{
      currentVersionId: string | null;
      previousVersionId: string | null;
      generation: number;
      updatedAt: Date;
    }>
  >`
    SELECT
      current_version_id AS "currentVersionId",
      previous_version_id AS "previousVersionId",
      generation,
      updated_at AS "updatedAt"
    FROM environment_runtime_channels
    WHERE name = 'production'
  `;
  assert.ok(savedChannel);
  const createdVersionIds = new Set<string>();

  context.after(async () => {
    try {
      await connection`
        UPDATE environment_runtime_channels SET
          current_version_id = ${savedChannel.currentVersionId},
          previous_version_id = ${savedChannel.previousVersionId},
          generation = ${savedChannel.generation},
          updated_at = ${savedChannel.updatedAt}
        WHERE name = 'production'
      `;
      await connection`
        DELETE FROM environment_operations
        WHERE environment_id IN (${canaryId}, ${siblingId})
      `;
      await connection`
        DELETE FROM environments WHERE id IN (${canaryId}, ${siblingId})
      `;
      if (createdVersionIds.size) {
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
      id, name, email, role, "emailVerified", "createdAt", "updatedAt"
    ) VALUES (
      ${userId}, 'Manual Runtime Admin', ${`${userId}@example.test`}, 'admin',
      true, ${now}, ${now}
    )
  `;
  await connection`
    INSERT INTO organization (id, name, slug, "createdAt")
    VALUES (${organizationId}, 'Manual Runtime Org', ${`manual-${suffix}`}, ${now})
  `;

  const initial = (
    await runtime.registerEnvironmentRuntimeVersion({
      runtimeImage: runtimeImage(suffix, "initial"),
      routerImage: routerImage(suffix, "initial"),
    })
  ).version;
  const proposed = (
    await runtime.registerEnvironmentRuntimeVersion({
      runtimeImage: runtimeImage(suffix, "proposed"),
      routerImage: routerImage(suffix, "proposed"),
    })
  ).version;
  createdVersionIds.add(initial.id);
  createdVersionIds.add(proposed.id);

  for (const [id, name] of [
    [canaryId, "Manual Canary"],
    [siblingId, "Manual Sibling"],
  ]) {
    await connection`
      INSERT INTO environments (
        id, organization_id, created_by_user_id, name, slug, provider, region,
        status, fly_app_name, fly_gateway_machine_id, router_url,
        runtime_image, router_image
      ) VALUES (
        ${id}, ${organizationId}, ${userId}, ${name}, ${id}, 'fly', 'iad',
        'ready', ${id}, ${`gateway-${id}`}, 'https://router.example.test',
        ${initial.runtimeImage}, ${initial.routerImage}
      )
    `;
  }
  const generation = savedChannel.generation + 10;
  await connection`
    UPDATE environment_runtime_channels SET
      current_version_id = ${initial.id},
      previous_version_id = NULL,
      generation = ${generation},
      updated_at = now()
    WHERE name = 'production'
  `;

  const mismatchedOperationId = `runtime-mismatch-${suffix}`;
  await connection`
    INSERT INTO environment_operations (
      id, organization_id, environment_id, requested_by_user_id, type,
      status, stage, idempotency_key, input
    ) VALUES (
      ${mismatchedOperationId}, ${organizationId}, ${canaryId}, ${userId},
      'environment.update', 'queued', 'requested',
      ${`runtime-mismatch:${suffix}`},
      ${connection.json({
        runtimeVersionId: proposed.id,
        runtimeImage: initial.runtimeImage,
        routerImage: proposed.routerImage,
      })}
    )
  `;
  await assert.rejects(
    processRuntime.processEnvironmentOperation(mismatchedOperationId),
    /do not match the immutable Runtime Version/u,
  );

  const requested = await runtime.requestEnvironmentRuntimeUpdate({
    organizationId,
    environmentId: canaryId,
    runtimeVersionId: proposed.id,
    actorUserId: userId,
  });
  const [siblingOperations] = await connection<Array<{ count: number }>>`
    SELECT count(*)::int AS count
    FROM environment_operations
    WHERE environment_id = ${siblingId}
  `;
  assert.equal(siblingOperations?.count, 0);

  await completeUpdate(connection, {
    environmentId: canaryId,
    operationId: requested.operation.id,
    runtimeImage: proposed.runtimeImage,
    routerImage: proposed.routerImage,
  });
  const activated = await runtime.activateEnvironmentRuntimeVersion({
    runtimeVersionId: proposed.id,
    canaryOperationId: requested.operation.id,
  });
  assert.deepEqual(activated, {
    versionId: proposed.id,
    generation: generation + 1,
    canaryEnvironmentId: canaryId,
    alreadyCurrent: false,
  });
  const channel = await runtime.getEnvironmentRuntimeChannel();
  assert.equal(channel.currentVersion?.id, proposed.id);
  assert.equal(channel.previousVersion?.id, initial.id);

  const [sibling] = await connection<
    Array<{ runtimeImage: string; routerImage: string }>
  >`
    SELECT runtime_image AS "runtimeImage", router_image AS "routerImage"
    FROM environments WHERE id = ${siblingId}
  `;
  assert.deepEqual(sibling, {
    runtimeImage: initial.runtimeImage,
    routerImage: initial.routerImage,
  });
});

async function completeUpdate(
  sql: Awaited<ReturnType<postgres.Sql["reserve"]>>,
  input: {
    environmentId: string;
    operationId: string;
    runtimeImage: string;
    routerImage: string;
  },
) {
  await sql`
    UPDATE environments SET
      runtime_image = ${input.runtimeImage},
      router_image = ${input.routerImage},
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
  return `ghcr.io/lumicorp/kestrel-workspace-runtime:${role}-${suffix}`;
}

function routerImage(suffix: string, role: string) {
  return `ghcr.io/lumicorp/kestrel-environment-router:${role}-${suffix}`;
}
