import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import postgres from "postgres";
import { test } from "node:test";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("release-owned execution bypasses only its exact release target", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");

  const [
    { resetDbRuntimeForTests },
    { finalizeHostedEnvironmentExecutionAuthorization },
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./execution-route"),
  ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const organizationId = `org-release-route-${suffix}`;
  const userId = `user-release-route-${suffix}`;
  const threadId = `thread-release-route-${suffix}`;
  const environmentId = `environment-release-route-${suffix}`;
  const workspaceId = `workspace-release-route-${suffix}`;
  const releaseId = `release-route-${suffix}`;
  const owningTargetId = `release-target-owning-${suffix}`;
  const unrelatedTargetId = `release-target-unrelated-${suffix}`;
  const previousTicketKey = process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY;
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const now = new Date();

  context.after(async () => {
    await sql`DELETE FROM "fly_image_releases" WHERE "id" = ${releaseId}`.catch(
      () => {},
    );
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`.catch(
      () => {},
    );
    if (previousTicketKey === undefined) {
      Reflect.deleteProperty(
        process.env,
        "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
      );
    } else {
      process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY = previousTicketKey;
    }
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${userId}, 'Release Route User', ${`${userId}@example.test`},
        true, ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${organizationId}, 'Release Route Org',
        ${`release-route-${suffix}`}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "threads" (
        "id", "title", "created_by_user_id", "organization_id"
      ) VALUES (
        ${threadId}, 'Release Route Thread', ${userId}, ${organizationId}
      )
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "region", "status", "fly_app_name", "router_url",
        "fly_gateway_machine_id", "runtime_image"
      ) VALUES (
        ${environmentId}, ${organizationId}, ${userId},
        'Release Route Environment', ${`release-route-${suffix}`},
        'iad', 'ready', ${`fly-release-route-${suffix}`},
        'https://router.example.test', ${`gateway-${suffix}`},
        'registry.example/workspace@sha256:test'
      )
    `;
    await transaction`
      INSERT INTO "environment_workspaces" (
        "id", "organization_id", "environment_id", "standalone_thread_id",
        "created_by_user_id", "name", "kind", "status", "fly_machine_id",
        "fly_volume_id", "runtime_image"
      ) VALUES (
        ${workspaceId}, ${organizationId}, ${environmentId}, ${threadId},
        ${userId}, 'Release Route Workspace', 'scratch', 'ready',
        ${`machine-${suffix}`}, ${`volume-${suffix}`},
        'registry.example/workspace@sha256:test'
      )
    `;
    await transaction`
      INSERT INTO "fly_image_releases" (
        "id", "bundle_revision", "manifest_digest", "trigger", "status",
        "validation", "created_at", "updated_at"
      ) VALUES (
        ${releaseId}, ${"a".repeat(40)}, ${`sha256:${"b".repeat(64)}`},
        'manual', 'deploying', ${transaction.json({})}, ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "fly_image_release_targets" (
        "id", "release_id", "target_kind", "environment_id", "workspace_id",
        "target_key", "status", "stage", "created_at", "updated_at"
      ) VALUES
        (
          ${owningTargetId}, ${releaseId}, 'workspace', ${environmentId},
          ${workspaceId}, ${`owning:${suffix}`}, 'applying', 'applying',
          ${now}, ${now}
        ),
        (
          ${unrelatedTargetId}, ${releaseId}, 'environment', ${environmentId},
          NULL, ${`unrelated:${suffix}`}, 'verifying', 'verifying',
          ${now}, ${now}
        )
    `;
  });

  const authorize = (owningReleaseTargetIds?: readonly string[]) =>
    finalizeHostedEnvironmentExecutionAuthorization({
      runId: crypto.randomUUID(),
      organizationId,
      environmentId,
      workspaceId,
      threadId,
      actorUserId: userId,
      agentId: "release-backup",
      effectiveCapabilities: ["workspace.backups.export"],
      reasoningPolicy: {
        request: { mode: "summary", effort: "medium" },
        retention: { mode: "provider_visible", days: 30 },
      },
      owningReleaseTargetIds,
    });

  assert.equal(await authorize([owningTargetId]), null);

  await sql`
    UPDATE "fly_image_release_targets"
    SET "status" = 'completed', "stage" = 'completed', "updated_at" = ${now}
    WHERE "id" = ${unrelatedTargetId}
  `;
  assert.ok(await authorize([owningTargetId]));
  assert.equal(await authorize(), null);
});
