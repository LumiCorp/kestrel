import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { verifyEnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("execution authorization renews active authority and denies stale authority", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const previous = {
    privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY,
    publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
    appUrl: process.env.KESTREL_ONE_APP_URL,
  };
  process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY = privateKey;
  process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY = publicKey;
  process.env.KESTREL_ONE_APP_URL = "https://kestrel.example";
  const [{ resetDbRuntimeForTests }, executionRoute, renewal] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./execution-route"),
    import("./authorization-renewal"),
  ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const ids = {
    user: crypto.randomUUID(),
    organization: crypto.randomUUID(),
    thread: crypto.randomUUID(),
    environment: crypto.randomUUID(),
    workspace: crypto.randomUUID(),
    execution: crypto.randomUUID(),
  };
  const now = new Date("2026-08-11T12:00:00.000Z");
  context.after(async () => {
    await sql`DELETE FROM "environment_run_executions" WHERE "id" = ${ids.execution}`;
    await sql`DELETE FROM "environment_workspaces" WHERE "id" = ${ids.workspace}`;
    await sql`DELETE FROM "environments" WHERE "id" = ${ids.environment}`;
    await sql`DELETE FROM "threads" WHERE "id" = ${ids.thread}`;
    await sql`DELETE FROM "member" WHERE "organizationId" = ${ids.organization}`;
    await sql`DELETE FROM "organization" WHERE "id" = ${ids.organization}`;
    await sql`DELETE FROM "user" WHERE "id" = ${ids.user}`;
    restore("KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY", previous.privateKey);
    restore("KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY", previous.publicKey);
    restore("KESTREL_ONE_APP_URL", previous.appUrl);
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });
  await sql.begin(async (tx) => {
    await tx`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (${ids.user}, 'Renewal User', ${`${suffix}@example.test`}, true, ${now}, ${now})`;
    await tx`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (${ids.organization}, 'Renewal Org', ${`renewal-${suffix}`}, ${now})`;
    await tx`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES (${crypto.randomUUID()}, ${ids.organization}, ${ids.user}, 'owner', ${now})`;
    await tx`INSERT INTO "threads" ("id", "title", "created_by_user_id", "organization_id") VALUES (${ids.thread}, 'Renewal Thread', ${ids.user}, ${ids.organization})`;
    await tx`INSERT INTO "environments" ("id", "organization_id", "created_by_user_id", "name", "slug", "region", "status", "fly_app_name", "router_url", "fly_gateway_machine_id", "runtime_image") VALUES (${ids.environment}, ${ids.organization}, ${ids.user}, 'Renewal Env', ${`renewal-${suffix}`}, 'iad', 'ready', ${`fly-${suffix}`}, 'https://router.example.test', ${`gateway-${suffix}`}, 'registry.example/workspace@sha256:test')`;
    await tx`INSERT INTO "environment_workspaces" ("id", "organization_id", "environment_id", "standalone_thread_id", "created_by_user_id", "name", "kind", "status", "fly_machine_id", "fly_volume_id", "runtime_image") VALUES (${ids.workspace}, ${ids.organization}, ${ids.environment}, ${ids.thread}, ${ids.user}, 'Renewal Workspace', 'scratch', 'ready', ${`machine-${suffix}`}, ${`volume-${suffix}`}, 'registry.example/workspace@sha256:test')`;
  });

  const issued = await executionRoute.finalizeHostedEnvironmentExecutionAuthorization({
    runId: ids.execution,
    organizationId: ids.organization,
    environmentId: ids.environment,
    workspaceId: ids.workspace,
    threadId: ids.thread,
    actorUserId: ids.user,
    agentId: "renewal-test",
    effectiveCapabilities: [],
    reasoningPolicy: {
      request: { mode: "summary", effort: "medium" },
      retention: { mode: "provider_visible", days: 30 },
    },
    recordExecution: {},
  });
  assert.ok(issued?.authorizationRenewal);
  const initialTicket = verifyEnvironmentExecutionTicket({
    token: issued.executionTicket,
    publicKey,
  });
  const renewalNow = new Date((initialTicket.expiresAt + 1) * 1000);
  const renewed = await renewal.renewEnvironmentExecutionAuthorization({
    executionId: ids.execution,
    renewalToken: issued.authorizationRenewal.token,
    executionTicket: issued.executionTicket,
    now: renewalNow,
  });
  const verified = verifyEnvironmentExecutionTicket({
    token: renewed.executionTicket,
    publicKey,
    now: Math.floor(renewalNow.getTime() / 1000) + 1,
  });
  assert.equal(verified.runId, ids.execution);
  assert.equal(verified.expiresAt - verified.issuedAt, 300);

  await assert.rejects(
    renewal.renewEnvironmentExecutionAuthorization({
      executionId: ids.execution,
      renewalToken: "wrong-renewal-token",
      executionTicket: renewed.executionTicket,
    }),
    (error: unknown) =>
      error instanceof renewal.ExecutionAuthorizationRenewalError &&
      error.code === "EXECUTION_AUTH_RENEWAL_DENIED",
  );
  await sql`UPDATE "environment_run_executions" SET "status" = 'completed', "completed_at" = ${now} WHERE "id" = ${ids.execution}`;
  await assert.rejects(
    renewal.renewEnvironmentExecutionAuthorization({
      executionId: ids.execution,
      renewalToken: issued.authorizationRenewal.token,
      executionTicket: renewed.executionTicket,
    }),
    (error: unknown) =>
      error instanceof renewal.ExecutionAuthorizationRenewalError &&
      error.code === "EXECUTION_AUTH_RENEWAL_DENIED",
  );
});

function restore(key: string, value: string | undefined) {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}
