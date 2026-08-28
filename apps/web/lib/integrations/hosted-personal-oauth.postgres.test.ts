import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test("hosted personal OAuth persists a fixed-origin, organization-pack-bound, single-use authorization", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  const originalActiveKeyId = process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID;
  const originalKeyring = process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS;
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "hosted-personal-oauth-test";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "hosted-personal-oauth-test": randomBytes(32).toString("base64"),
  });

  const [{ resetDbRuntimeForTests }, registrations, broker, appService] = await Promise.all([
    import("@/lib/db/runtime"),
    import("@/lib/apps/platform-oauth-registrations"),
    import("./hosted-personal-oauth"),
    import("@/lib/apps/service"),
  ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const userId = `hosted-personal-oauth-${suffix}`;
  const organizationId = `hosted-personal-oauth-org-${suffix}`;
  const memberId = `hosted-personal-oauth-member-${suffix}`;
  const environmentId = `hosted-personal-oauth-environment-${suffix}`;
  const projectId = `hosted-personal-oauth-project-${suffix}`;
  const now = new Date();

  context.after(async () => {
    await sql`DELETE FROM "platform_personal_oauth_authorizations" WHERE "connection_id" IN (SELECT "id" FROM "app_connections" WHERE "organization_id" = ${organizationId})`;
    await sql`DELETE FROM "platform_personal_oauth_authorization_sessions" WHERE "organization_id" = ${organizationId}`;
    await sql`DELETE FROM "app_connections" WHERE "organization_id" = ${organizationId}`;
    await sql`DELETE FROM "app_installations" WHERE "organization_id" = ${organizationId}`;
    await sql`DELETE FROM "projects" WHERE "id" = ${projectId}`;
    await sql`DELETE FROM "environment_app_capability_grants" WHERE "environment_id" = ${environmentId}`;
    await sql`DELETE FROM "environments" WHERE "id" = ${environmentId}`;
    await sql`DELETE FROM "member" WHERE "id" = ${memberId}`;
    await sql`DELETE FROM "platform_oauth_registrations" WHERE "updated_by_user_id" = ${userId}`;
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
    if (originalActiveKeyId === undefined) Reflect.deleteProperty(process.env, "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID");
    else process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = originalActiveKeyId;
    if (originalKeyring === undefined) Reflect.deleteProperty(process.env, "KESTREL_GATEWAY_CREDENTIAL_KEYS");
    else process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = originalKeyring;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (${userId}, 'Broker Test User', ${`${userId}@example.test`}, true, ${now}, ${now})`;
  await sql`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (${organizationId}, 'Broker Test Org', ${`broker-${suffix}`}, ${now})`;
  await appService.ensureCoreAppCatalog();
  await sql`INSERT INTO "app_installations" ("organization_id", "app_key", "status", "settings", "installed_at", "created_at", "updated_at") VALUES (${organizationId}, 'google_workspace', 'installed', '{}'::jsonb, ${now}, ${now}, ${now})`;
  await registrations.savePlatformOAuthRegistration({
    actorUserId: userId,
    provider: "google_workspace",
    clientId: "google-client",
    clientSecret: "google-secret",
    enabled: true,
    enabledPacks: ["gmail", "calendar"],
    expectedRevision: null,
  });
  const started = await broker.startHostedPersonalAuthorization({
    provider: "google_workspace",
    organizationId,
    userId,
    packs: ["gmail", "calendar"],
    env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
  });
  const url = new URL(started.authorizationUrl);
  assert.equal(url.searchParams.get("redirect_uri"), "https://one.example.test/api/integrations/oauth/google-workspace/callback");
  const sessionId = url.searchParams.get("state");
  assert.ok(sessionId);
  const [stored] = await sql`SELECT "encrypted_pkce_verifier" AS "verifier" FROM "platform_personal_oauth_authorization_sessions" WHERE "id" = ${sessionId}`;
  assert.match(stored.verifier, /^kgc:v1:/u);
  assert.doesNotMatch(stored.verifier, /google-secret|code-verifier/u);

  const completed = await broker.completeHostedPersonalAuthorization({
      provider: "google_workspace",
      sessionId,
      userId,
      code: "provider-code",
      env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
      fetchImpl: (async (request) => {
        const value = String(request);
        if (value === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "provider-access", refresh_token: "provider-refresh", token_type: "Bearer", expires_in: 3600, scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy" });
        }
        if (value === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({ sub: "provider-user", email: "provider@example.test" });
        }
        throw new Error(`Unexpected provider URL: ${value}`);
      }) as typeof fetch,
  });
  await assert.rejects(
    broker.completeHostedPersonalAuthorization({ provider: "google_workspace", sessionId, userId, code: "reused-code" }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_SESSION_USED",
  );

  await sql`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', ${now})`;
  await sql`INSERT INTO "environments" ("id", "organization_id", "created_by_user_id", "name", "slug", "region", "status", "is_default", "created_at", "updated_at") VALUES (${environmentId}, ${organizationId}, ${userId}, 'Broker Environment', ${`broker-env-${suffix}`}, 'iad', 'ready', true, ${now}, ${now})`;
  await sql.begin(async (transaction) => {
    await transaction`INSERT INTO "projects" ("id", "organization_id", "environment_id", "created_by_user_id", "name", "created_at", "updated_at") VALUES (${projectId}, ${organizationId}, ${environmentId}, ${userId}, 'Broker Project', ${now}, ${now})`;
    await transaction`INSERT INTO "project_members" ("project_id", "organization_member_id", "role", "created_at", "updated_at") VALUES (${projectId}, ${memberId}, 'owner', ${now}, ${now})`;
  });
  await sql`INSERT INTO "project_apps" ("project_id", "app_key", "enabled", "added_by_user_id", "created_at", "updated_at") VALUES (${projectId}, 'google_workspace', true, ${userId}, ${now}, ${now})`;
  await sql`INSERT INTO "project_app_connections" ("project_id", "app_key", "connection_id", "scope", "user_id", "is_default", "added_by_user_id", "created_at", "updated_at") VALUES (${projectId}, 'google_workspace', ${completed.connectionId}, 'personal', ${userId}, true, ${userId}, ${now}, ${now})`;
  await sql`INSERT INTO "environment_app_capability_grants" ("environment_id", "app_key", "capability_key", "enabled", "approval_mode", "logging_mode", "rate_limit_mode", "created_at", "updated_at") VALUES
    (${environmentId}, 'google_workspace', 'calendar.events.read', true, 'auto', 'metadata_only', 'strict', ${now}, ${now}),
    (${environmentId}, 'google_workspace', 'gmail.messages.search', true, 'auto', 'metadata_only', 'strict', ${now}, ${now})`;
  await sql`UPDATE "platform_personal_oauth_authorizations" SET "expires_at" = ${new Date(now.getTime() - 60_000)} WHERE "connection_id" = ${completed.connectionId}`;

  let refreshCalls = 0;
  const refreshFetch = (async (request) => {
    assert.equal(String(request), "https://oauth2.googleapis.com/token");
    refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({ access_token: "refreshed-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 });
  }) as typeof fetch;
  const resolveCalendar = () => broker.resolveHostedPersonalProviderToken({
    provider: "google_workspace",
    connectionId: completed.connectionId,
    organizationId,
    userId,
    projectId,
    operation: "events.list",
    fetchImpl: refreshFetch,
  });
  const [firstRefresh, secondRefresh] = await Promise.all([resolveCalendar(), resolveCalendar()]);
  assert.equal(firstRefresh.accessToken, "refreshed-access");
  assert.equal(secondRefresh.accessToken, "refreshed-access");
  assert.equal(refreshCalls, 1, "concurrent callers share the serialized refresh");
  await assert.rejects(
    broker.resolveHostedPersonalProviderToken({ provider: "google_workspace", connectionId: completed.connectionId, organizationId, userId, projectId, operation: "gmail.messages.search" }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_MODEL_ADMISSION_REQUIRED",
  );
  const issuedAt = Math.floor(Date.now() / 1_000);
  const unadmittedTicket: EnvironmentExecutionTicket = {
    version: 1,
    audience: "kestrel-environment-router",
    organizationId,
    environmentId,
    workspaceId: `hosted-personal-oauth-workspace-${suffix}`,
    threadId: `hosted-personal-oauth-thread-${suffix}`,
    runId: `hosted-personal-oauth-run-${suffix}`,
    actorId: userId,
    agentId: "kestrel-one",
    flyAppName: "hosted-personal-oauth-test",
    flyMachineId: "hosted-personal-oauth-test",
    capabilities: ["kestrel.tools.invoke"],
    issuedAt,
    expiresAt: issuedAt + 300,
    nonce: crypto.randomUUID(),
  };
  await assert.rejects(
    broker.resolveHostedPersonalProviderToken({ provider: "google_workspace", connectionId: completed.connectionId, organizationId, userId, projectId, operation: "gmail.messages.search", gmailExecution: unadmittedTicket }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_GMAIL_EXECUTION_DENIED",
  );
  await assert.rejects(
    broker.resolveHostedPersonalProviderToken({ provider: "google_workspace", connectionId: completed.connectionId, organizationId, userId, projectId, operation: "chats.list" }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_OPERATION_UNSUPPORTED",
  );

  await sql`UPDATE "app_installations" SET "settings" = ${JSON.stringify({ personalOAuthPacks: ["calendar"] })}::jsonb WHERE "organization_id" = ${organizationId} AND "app_key" = 'google_workspace'`;
  await assert.rejects(
    broker.startHostedPersonalAuthorization({ provider: "google_workspace", organizationId, userId, packs: ["gmail"] }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_ORGANIZATION_PACK_DENIED",
  );
});
