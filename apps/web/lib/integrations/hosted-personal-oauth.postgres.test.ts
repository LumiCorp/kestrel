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

  await sql`INSERT INTO "app_installations" ("organization_id", "app_key", "status", "settings", "installed_at", "created_at", "updated_at") VALUES (${organizationId}, 'microsoft_365', 'installed', '{}'::jsonb, ${now}, ${now}, ${now})`;
  await registrations.savePlatformOAuthRegistration({
    actorUserId: userId,
    provider: "microsoft_365",
    clientId: "microsoft-client",
    clientSecret: "microsoft-secret",
    tenantOrIssuer: "organizations",
    enabled: true,
    enabledPacks: ["teams"],
    expectedRevision: null,
  });
  const missingTeamsReadStart = await broker.startHostedPersonalAuthorization({
    provider: "microsoft_365",
    organizationId,
    userId,
    packs: ["teams"],
    env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
  });
  const missingTeamsReadSessionId = new URL(missingTeamsReadStart.authorizationUrl).searchParams.get("state");
  assert.ok(missingTeamsReadSessionId);
  await assert.rejects(
    broker.completeHostedPersonalAuthorization({
      provider: "microsoft_365",
      sessionId: missingTeamsReadSessionId,
      userId,
      code: "missing-teams-read-code",
      env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
      fetchImpl: (async (request) => {
        assert.equal(String(request), "https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
        return Response.json({
          access_token: "microsoft-no-read-access",
          refresh_token: "microsoft-no-read-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid profile email offline_access User.Read",
        });
      }) as typeof fetch,
    }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_CONNECTION_SCOPE_DENIED",
  );
  const [missingTeamsReadConnection] = await sql`SELECT count(*)::int AS "count" FROM "app_connections" WHERE "organization_id" = ${organizationId} AND "app_key" = 'microsoft_365'`;
  assert.equal(missingTeamsReadConnection.count, 0);

  const teamsReadOnlyStart = await broker.startHostedPersonalAuthorization({
    provider: "microsoft_365",
    organizationId,
    userId,
    packs: ["teams"],
    env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
  });
  const teamsReadOnlySessionId = new URL(teamsReadOnlyStart.authorizationUrl).searchParams.get("state");
  assert.ok(teamsReadOnlySessionId);
  const teamsReadOnly = await broker.completeHostedPersonalAuthorization({
    provider: "microsoft_365",
    sessionId: teamsReadOnlySessionId,
    userId,
    code: "teams-read-only-code",
    env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
    fetchImpl: (async (request) => {
      const value = String(request);
      if (value === "https://login.microsoftonline.com/organizations/oauth2/v2.0/token") {
        return Response.json({
          access_token: "microsoft-read-access",
          refresh_token: "microsoft-read-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid profile email offline_access User.Read Chat.Read",
        });
      }
      if (value === "https://graph.microsoft.com/oidc/userinfo") {
        return Response.json({ sub: "microsoft-provider-user", preferred_username: "person@company.example" });
      }
      throw new Error(`Unexpected provider URL: ${value}`);
    }) as typeof fetch,
  });
  const [teamsReadOnlyConnection] = await sql`SELECT "status", "scopes", "delivery_config" AS "deliveryConfig" FROM "app_connections" WHERE "id" = ${teamsReadOnly.connectionId}`;
  assert.equal(teamsReadOnlyConnection.status, "connected");
  assert.equal(teamsReadOnlyConnection.scopes.includes("Chat.Read"), true);
  assert.equal(teamsReadOnlyConnection.scopes.includes("ChatMessage.Send"), false);
  assert.deepEqual(teamsReadOnlyConnection.deliveryConfig, { capabilityPacks: ["teams"] });

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
    (${environmentId}, 'google_workspace', 'calendar.availability.read', true, 'auto', 'metadata_only', 'strict', ${now}, ${now}),
    (${environmentId}, 'google_workspace', 'gmail.messages.search', true, 'auto', 'metadata_only', 'strict', ${now}, ${now})`;
  await sql`UPDATE "platform_personal_oauth_authorizations" SET "expires_at" = ${new Date(now.getTime() - 60_000)} WHERE "connection_id" = ${completed.connectionId}`;

  let refreshCalls = 0;
  const refreshFetch = (async (request) => {
    assert.equal(String(request), "https://oauth2.googleapis.com/token");
    refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // OAuth providers can omit openid/email/profile in a refresh scope
    // response. Those protocol scopes are not lost App capability authority.
    return Response.json({ access_token: "refreshed-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy" });
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
  await sql`UPDATE "environment_app_capability_grants" SET "enabled" = false WHERE "environment_id" = ${environmentId} AND "app_key" = 'google_workspace' AND "capability_key" = 'calendar.events.read'`;
  const availabilityToken = await broker.resolveHostedPersonalProviderToken({
    provider: "google_workspace",
    connectionId: completed.connectionId,
    organizationId,
    userId,
    projectId,
    operation: "availability.query",
  });
  assert.equal(availabilityToken.accessToken, "refreshed-access");
  await assert.rejects(
    broker.resolveHostedPersonalProviderToken({ provider: "google_workspace", connectionId: completed.connectionId, organizationId, userId, projectId, operation: "events.list" }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_OPERATION_DENIED",
  );
  await sql`UPDATE "environment_app_capability_grants" SET "enabled" = true WHERE "environment_id" = ${environmentId} AND "app_key" = 'google_workspace' AND "capability_key" = 'calendar.events.read'`;
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

  await sql`UPDATE "app_installations" SET "settings" = '{}'::jsonb WHERE "organization_id" = ${organizationId} AND "app_key" = 'google_workspace'`;
  const narrowedPolicyStart = await broker.startHostedPersonalAuthorization({
    provider: "google_workspace",
    organizationId,
    userId,
    packs: ["gmail"],
    env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
  });
  const narrowedPolicySessionId = new URL(narrowedPolicyStart.authorizationUrl).searchParams.get("state");
  assert.ok(narrowedPolicySessionId);
  await assert.rejects(
    broker.completeHostedPersonalAuthorization({
      provider: "google_workspace",
      sessionId: narrowedPolicySessionId,
      userId,
      code: "narrowed-policy-code",
      env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
      fetchImpl: (async (request) => {
        const value = String(request);
        if (value === "https://oauth2.googleapis.com/token") {
          // This is deliberately after the callback began and before its
          // provider exchange resolves: callback persistence must observe the
          // now-current Organization policy, not its earlier authorization.
          await sql`UPDATE "app_installations" SET "settings" = ${JSON.stringify({ personalOAuthPacks: ["calendar"] })}::jsonb WHERE "organization_id" = ${organizationId} AND "app_key" = 'google_workspace'`;
          return Response.json({ access_token: "narrowed-policy-access", refresh_token: "narrowed-policy-refresh", token_type: "Bearer", expires_in: 3600, scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly" });
        }
        if (value === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({ sub: "provider-user", email: "provider@example.test" });
        }
        throw new Error(`Unexpected provider URL: ${value}`);
      }) as typeof fetch,
    }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_ORGANIZATION_PACK_DENIED",
  );
  const [policyDeniedAuthorization] = await sql`SELECT "selected_packs" AS "selectedPacks", "encrypted_token_payload" AS "tokenPayload" FROM "platform_personal_oauth_authorizations" WHERE "connection_id" = ${completed.connectionId}`;
  assert.deepEqual(policyDeniedAuthorization.selectedPacks, ["gmail", "calendar"]);
  assert.doesNotMatch(policyDeniedAuthorization.tokenPayload, /narrowed-policy-(?:access|refresh)/u);
  await assert.rejects(
    broker.resolveHostedPersonalProviderToken({ provider: "google_workspace", connectionId: completed.connectionId, organizationId, userId, projectId, operation: "gmail.messages.search" }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_ORGANIZATION_PACK_DENIED",
  );

  await sql`UPDATE "app_installations" SET "settings" = '{}'::jsonb WHERE "organization_id" = ${organizationId} AND "app_key" = 'google_workspace'`;
  const malformedPolicyStart = await broker.startHostedPersonalAuthorization({
    provider: "google_workspace",
    organizationId,
    userId,
    packs: ["calendar"],
    env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
  });
  const malformedPolicySessionId = new URL(malformedPolicyStart.authorizationUrl).searchParams.get("state");
  assert.ok(malformedPolicySessionId);
  await sql`UPDATE "app_installations" SET "settings" = ${JSON.stringify({ personalOAuthPacks: "calendar" })}::jsonb WHERE "organization_id" = ${organizationId} AND "app_key" = 'google_workspace'`;
  await assert.rejects(
    broker.completeHostedPersonalAuthorization({
      provider: "google_workspace",
      sessionId: malformedPolicySessionId,
      userId,
      code: "malformed-policy-code",
      env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
    }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_ORGANIZATION_POLICY_INVALID",
  );
  await assert.rejects(
    broker.resolveHostedPersonalProviderToken({ provider: "google_workspace", connectionId: completed.connectionId, organizationId, userId, projectId, operation: "events.list" }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_ORGANIZATION_POLICY_INVALID",
  );

  await sql`UPDATE "app_installations" SET "settings" = '{}'::jsonb WHERE "organization_id" = ${organizationId} AND "app_key" = 'google_workspace'`;
  await sql`UPDATE "platform_personal_oauth_authorizations" SET "expires_at" = ${new Date(Date.now() - 60_000)} WHERE "connection_id" = ${completed.connectionId}`;
  await assert.rejects(
    broker.resolveHostedPersonalProviderToken({
      provider: "google_workspace",
      connectionId: completed.connectionId,
      organizationId,
      userId,
      projectId,
      operation: "events.list",
      fetchImpl: (async () => Response.json({
        access_token: "scope-reduced-access",
        refresh_token: "scope-reduced-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        // events.list remains usable, but refresh drops the prior Gmail
        // authority. The connection envelope—not just this operation—must
        // then require reconnect.
        scope: "https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy",
      })) as unknown as typeof fetch,
    }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_RECONNECT_REQUIRED",
  );
  const [scopeReducedAuthorization] = await sql`SELECT "granted_scopes" AS "grantedScopes", "encrypted_token_payload" AS "tokenPayload", "reconnect_required" AS "reconnectRequired", "failure_code" AS "failureCode" FROM "platform_personal_oauth_authorizations" WHERE "connection_id" = ${completed.connectionId}`;
  const [scopeReducedConnection] = await sql`SELECT "scopes", "status", "failure_code" AS "failureCode" FROM "app_connections" WHERE "id" = ${completed.connectionId}`;
  assert.deepEqual(scopeReducedAuthorization.grantedScopes, [
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ]);
  assert.equal(scopeReducedAuthorization.reconnectRequired, true);
  assert.equal(scopeReducedAuthorization.failureCode, "OAUTH_SCOPE_REDUCED");
  assert.doesNotMatch(scopeReducedAuthorization.tokenPayload, /scope-reduced-(?:access|refresh)/u);
  assert.deepEqual(scopeReducedConnection.scopes, [
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ]);
  assert.equal(scopeReducedConnection.status, "degraded");
  assert.equal(scopeReducedConnection.failureCode, "OAUTH_SCOPE_REDUCED");
  await sql`UPDATE "platform_personal_oauth_authorizations" SET "granted_scopes" = '[]'::jsonb WHERE "connection_id" = ${completed.connectionId}`;
  await assert.rejects(
    broker.resolveHostedPersonalProviderToken({
      provider: "google_workspace",
      connectionId: completed.connectionId,
      organizationId,
      userId,
      projectId,
      operation: "events.list",
    }),
    // A missing Calendar scope must not mask the already durable reconnect
    // outcome.
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_RECONNECT_REQUIRED",
  );

  const reconnectStart = await broker.startHostedPersonalAuthorization({
    provider: "google_workspace",
    organizationId,
    userId,
    packs: ["gmail", "calendar"],
    env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
  });
  const reconnectSessionId = new URL(reconnectStart.authorizationUrl).searchParams.get("state");
  assert.ok(reconnectSessionId);
  const reconnected = await broker.completeHostedPersonalAuthorization({
    provider: "google_workspace",
    sessionId: reconnectSessionId,
    userId,
    code: "reconnect-code",
    env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://one.example.test" },
    fetchImpl: (async (request) => {
      const value = String(request);
      if (value === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "reconnected-access", refresh_token: "reconnected-refresh", token_type: "Bearer", expires_in: 3600, scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy" });
      }
      if (value === "https://openidconnect.googleapis.com/v1/userinfo") {
        return Response.json({ sub: "provider-user", email: "provider@example.test" });
      }
      throw new Error(`Unexpected provider URL: ${value}`);
    }) as typeof fetch,
  });
  assert.equal(reconnected.connectionId, completed.connectionId);
  await sql`UPDATE "platform_personal_oauth_authorizations" SET "expires_at" = ${new Date(Date.now() - 60_000)} WHERE "connection_id" = ${completed.connectionId}`;
  await assert.rejects(
    broker.resolveHostedPersonalProviderToken({
      provider: "google_workspace",
      connectionId: completed.connectionId,
      organizationId,
      userId,
      projectId,
      operation: "events.list",
      fetchImpl: (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch,
    }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_RECONNECT_REQUIRED",
  );
  const [failedRefreshAuthorization] = await sql`SELECT "reconnect_required" AS "reconnectRequired", "failure_code" AS "failureCode" FROM "platform_personal_oauth_authorizations" WHERE "connection_id" = ${completed.connectionId}`;
  const [failedRefreshConnection] = await sql`SELECT "status", "failure_code" AS "failureCode" FROM "app_connections" WHERE "id" = ${completed.connectionId}`;
  assert.equal(failedRefreshAuthorization.reconnectRequired, true);
  assert.equal(failedRefreshAuthorization.failureCode, "OAUTH_REFRESH_FAILED");
  assert.equal(failedRefreshConnection.status, "degraded");
  assert.equal(failedRefreshConnection.failureCode, "OAUTH_REFRESH_FAILED");
  await assert.rejects(
    broker.resolveHostedPersonalProviderToken({ provider: "google_workspace", connectionId: completed.connectionId, organizationId, userId, projectId, operation: "events.list" }),
    (error: unknown) => error instanceof broker.HostedPersonalOAuthError && error.code === "OAUTH_RECONNECT_REQUIRED",
  );
});
