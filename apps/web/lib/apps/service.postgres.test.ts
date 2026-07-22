import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import postgres from "postgres";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

contractTest(
  "web.postgres",
  "Environment Apps persist encrypted named connections and capability ceilings",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");
    process.env.KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
    process.env.KESTREL_APP_CREDENTIAL_KEYS = JSON.stringify({
      "test-key": randomBytes(32).toString("base64"),
    });
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    process.env.KESTREL_MCP_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
    process.env.KESTREL_MCP_CREDENTIAL_KEYS = JSON.stringify({
      "test-key": randomBytes(32).toString("base64"),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const [
      { resetDbRuntimeForTests },
      environmentStore,
      appService,
      projectAppService,
      tavilyRuntime,
      appRuntime,
      ngrokPreviewLifecycle,
      environmentGatewayConfig,
      environmentServiceTokens,
      environmentReconcile,
      googleContract,
      googleOauth,
      googlePolicy,
      microsoftContract,
      microsoftOauth,
      githubOauth,
      officialRemoteConnection,
      mcpControl,
      mcpGrant,
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("@/lib/environments/store"),
      import("./service"),
      import("./project-service"),
      import("./tavily-runtime"),
      import("./runtime"),
      import("./ngrok-preview-lifecycle"),
      import("@/lib/environments/gateway-config"),
      import("@/lib/environments/service-tokens"),
      import("@/lib/environments/reconcile"),
      import("@/lib/integrations/google-calendar-contract"),
      import("@/lib/integrations/google-calendar-oauth"),
      import("@/lib/integrations/google-calendar-policy"),
      import("@/lib/integrations/microsoft-365-contract"),
      import("@/lib/integrations/microsoft-365-oauth"),
      import("@/lib/integrations/github-oauth"),
      import("./official-remote-connection"),
      import("@/lib/mcp/control-plane"),
      import("@/lib/mcp/grant-service"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const organizationId = `apps-org-${suffix}`;
    const userId = `apps-user-${suffix}`;
    const memberId = `apps-member-${suffix}`;
    const isolatedOrganizationId = `apps-isolated-org-${suffix}`;
    const isolatedUserId = `apps-isolated-user-${suffix}`;
    const isolatedMemberId = `apps-isolated-member-${suffix}`;
    const projectId = `apps-project-${suffix}`;
    const threadId = `apps-thread-${suffix}`;
    const workspaceId = `apps-workspace-${suffix}`;
    const runId = `apps-run-${suffix}`;
    const googleAuthAccountId = `apps-google-auth-${suffix}`;
    const googleProviderAccountId = `apps-google-provider-${suffix}`;
    const githubAuthAccountId = `apps-github-auth-${suffix}`;
    const githubProviderAccountId = `apps-github-provider-${suffix}`;
    const microsoftAuthAccountId = `apps-microsoft-auth-${suffix}`;
    const microsoftProviderAccountId = `apps-microsoft-provider-${suffix}`;
    const mcpSnapshotId = crypto.randomUUID();
    const mcpCapabilityId = crypto.randomUUID();
    const linearSnapshotId = crypto.randomUUID();
    const linearCapabilityId = crypto.randomUUID();
    const now = new Date();

    context.after(async () => {
      globalThis.fetch = originalFetch;
      await sql`DELETE FROM "organization" WHERE "id" = ${isolatedOrganizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${isolatedUserId}`;
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${userId}, 'Apps User', ${`${userId}@example.test`}, true, ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${organizationId}, 'Apps Org', ${`apps-org-${suffix}`}, ${now}
      )
    `;
    await sql`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${isolatedUserId}, 'Isolated Apps User',
        ${`${isolatedUserId}@example.test`}, true, ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${isolatedOrganizationId}, 'Isolated Apps Org',
        ${`apps-isolated-org-${suffix}`}, ${now}
      )
    `;
    await sql`
      INSERT INTO "account" (
        "id", "accountId", "providerId", "userId", "scope", "createdAt", "updatedAt"
      ) VALUES (
        ${googleAuthAccountId}, ${googleProviderAccountId}, 'google', ${userId},
        ${googleContract.GOOGLE_CALENDAR_SCOPES.join(" ")}, ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "account" (
        "id", "accountId", "providerId", "userId", "scope", "createdAt", "updatedAt"
      ) VALUES (
        ${microsoftAuthAccountId}, ${microsoftProviderAccountId},
        'microsoft-entra-id', ${userId},
        ${microsoftContract.scopesForMicrosoft365Packs(["outlook"]).join(" ")},
        ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "account" (
        "id", "accountId", "providerId", "userId", "scope", "createdAt", "updatedAt"
      ) VALUES (
        ${githubAuthAccountId}, ${githubProviderAccountId}, 'github', ${userId},
        'repo', ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', ${now})
    `;
    await sql`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES (
        ${isolatedMemberId}, ${isolatedOrganizationId}, ${isolatedUserId},
        'owner', ${now}
      )
    `;

    const createdEnvironment =
      await environmentStore.createOrganizationEnvironment({
        organizationId,
        userId,
        environment: {
          name: "Apps Environment",
          region: "iad",
          isDefault: true,
        },
      });
    const environmentId = createdEnvironment.environment.id;
    const isolatedEnvironment =
      await environmentStore.createOrganizationEnvironment({
        organizationId: isolatedOrganizationId,
        userId: isolatedUserId,
        environment: {
          name: "Isolated Apps Environment",
          region: "iad",
          isDefault: true,
        },
      });
    const isolatedEnvironmentId = isolatedEnvironment.environment.id;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "projects" (
          "id", "organization_id", "environment_id", "created_by_user_id", "name"
        ) VALUES (
          ${projectId}, ${organizationId}, ${environmentId}, ${userId}, 'Apps Project'
        )
      `;
      await transaction`
        INSERT INTO "project_members" (
          "project_id", "organization_member_id", "role"
        ) VALUES (${projectId}, ${memberId}, 'owner')
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id", "project_id"
        ) VALUES (
          ${threadId}, 'Apps runtime test', ${userId}, ${organizationId}, ${projectId}
        )
      `;
      await transaction`
        INSERT INTO "environment_workspaces" (
          "id", "organization_id", "environment_id", "project_id",
          "created_by_user_id", "name", "kind", "status"
        ) VALUES (
          ${workspaceId}, ${organizationId}, ${environmentId}, ${projectId},
          ${userId}, 'Apps workspace', 'project', 'ready'
        )
      `;
      await transaction`
        INSERT INTO "environment_run_executions" (
          "id", "organization_id", "environment_id", "workspace_id", "thread_id",
          "project_id", "actor_id", "runtime_image", "effective_capabilities"
        ) VALUES (
          ${runId}, ${organizationId}, ${environmentId}, ${workspaceId}, ${threadId},
          ${projectId}, ${userId}, 'apps-runtime-test', ${transaction.json([
            "app:tavily.search:auto",
            "app:tavily.research:ask",
          ])}
        )
      `;
      await transaction`
        INSERT INTO "thread_execution_bindings" (
          "thread_id", "organization_id", "environment_id", "workspace_id", "source",
          "bound_by_user_id"
        ) VALUES (
          ${threadId}, ${organizationId}, ${environmentId}, ${workspaceId}, 'project',
          ${userId}
        )
      `;
    });

    const environmentApps = await appService.listEnvironmentAppConfigurations({
      organizationId,
      environmentId,
    });
    const environmentWeather = environmentApps.find(
      (configuration) => configuration.app.key === "built_in.weather",
    );
    assert.equal(environmentWeather?.app.connectionModel, "environment");
    assert.equal(environmentWeather?.app.connectionRequirement, "optional");
    assert.equal(environmentWeather?.connections.length, 0);
    assert.equal(
      environmentWeather?.capabilities.find(
        (capability) => capability.key === "getWeather",
      )?.enabled,
      true,
    );

    const initialProjectApps =
      await projectAppService.listProjectAppConfigurations({
        organizationId,
        projectId,
        userId,
      });
    const projectWeather = initialProjectApps.find(
      (configuration) => configuration.app.key === "built_in.weather",
    );
    assert.equal(projectWeather?.enabled, true);
    assert.equal(projectWeather?.availableConnections.length, 0);
    assert.equal(projectWeather?.attachedConnections.length, 0);
    const initialWeatherAccess =
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: "built_in.weather",
        userId,
      });
    assert.equal(initialWeatherAccess?.connectionId, null);
    assert.deepEqual(
      initialWeatherAccess?.capabilities
        .map((capability) => ({
          key: capability.key,
          approvalMode: capability.approvalMode,
        }))
        .sort((left, right) => right.key.localeCompare(left.key)),
      [
        { key: "getWeather", approvalMode: "auto" },
        { key: "forecast", approvalMode: "auto" },
      ],
    );
    await projectAppService.saveProjectAppCapabilityPolicy({
      organizationId,
      projectId,
      appKey: "built_in.weather",
      capabilityKey: "getWeather",
      actorUserId: userId,
      enabled: false,
      approvalMode: "deny",
    });
    const weatherWithoutCurrent =
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: "built_in.weather",
        userId,
      });
    assert.deepEqual(
      weatherWithoutCurrent?.capabilities.map((capability) => capability.key),
      ["forecast"],
    );
    await projectAppService.saveProjectAppCapabilityPolicy({
      organizationId,
      projectId,
      appKey: "built_in.weather",
      capabilityKey: "getWeather",
      actorUserId: userId,
      enabled: true,
      approvalMode: "ask",
    });
    assert.equal(
      (
        await projectAppService.resolveEffectiveProjectAppAccess({
          organizationId,
          projectId,
          appKey: "built_in.weather",
          userId,
        })
      )?.capabilities.find((capability) => capability.key === "getWeather")
        ?.approvalMode,
      "ask",
    );
    await projectAppService.setProjectAppEnabled({
      organizationId,
      projectId,
      appKey: "built_in.weather",
      actorUserId: userId,
      enabled: false,
    });
    assert.equal(
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: "built_in.weather",
        userId,
      }),
      null,
    );
    await projectAppService.setProjectAppEnabled({
      organizationId,
      projectId,
      appKey: "built_in.weather",
      actorUserId: userId,
      enabled: true,
    });

    await appService.setAppInstallation({
      organizationId,
      appKey: "tavily",
      actorUserId: userId,
      installed: true,
    });
    const primary = await appService.saveEnvironmentAppConnection({
      organizationId,
      environmentId,
      appKey: "tavily",
      actorUserId: userId,
      connection: {
        name: "Primary",
        apiKey: "tvly-primary-secret",
      },
    });
    const updatedPrimary = await appService.saveEnvironmentAppConnection({
      organizationId,
      environmentId,
      appKey: "tavily",
      actorUserId: userId,
      connection: {
        name: "Primary",
        apiKey: "tvly-replacement-secret",
      },
    });
    assert.equal(updatedPrimary.id, primary.id);

    const research = await appService.saveEnvironmentAppConnection({
      organizationId,
      environmentId,
      appKey: "tavily",
      actorUserId: userId,
      connection: {
        name: "Research",
        apiKey: "tvly-research-secret",
        projectId: "research-project",
      },
    });
    const configuration = await appService.getEnvironmentAppConfiguration({
      organizationId,
      environmentId,
      appKey: "tavily",
    });
    assert.equal(configuration.connections.length, 2);
    assert.equal(configuration.capabilities.length, 10);
    assert.equal(
      JSON.stringify(configuration).includes("tvly-research-secret"),
      false,
    );

    const credential = await appService.resolveEnvironmentAppCredential({
      organizationId,
      environmentId,
      appKey: "tavily",
      connectionId: research.id,
    });
    assert.deepEqual(credential, {
      kind: "api_key",
      apiKey: "tvly-research-secret",
      projectId: "research-project",
    });

    await projectAppService.setProjectAppEnabled({
      organizationId,
      projectId,
      appKey: "tavily",
      actorUserId: userId,
      enabled: true,
    });
    await projectAppService.attachProjectAppConnection({
      organizationId,
      projectId,
      appKey: "tavily",
      connectionId: primary.id,
      actorUserId: userId,
      scope: "shared",
      isDefault: true,
    });
    await projectAppService.attachProjectAppConnection({
      organizationId,
      projectId,
      appKey: "tavily",
      connectionId: research.id,
      actorUserId: userId,
      scope: "shared",
      isDefault: true,
    });
    const projectConfiguration =
      await projectAppService.listProjectAppConfigurations({
        organizationId,
        projectId,
        userId,
      });
    const projectTavily = projectConfiguration.find(
      (configuration) => configuration.app.key === "tavily",
    );
    assert.equal(projectTavily?.availableConnections.length, 2);
    assert.equal(
      projectTavily?.attachedConnections.find(
        (connection) => connection.id === research.id,
      )?.isDefault,
      true,
    );
    assert.equal(
      projectTavily?.attachedConnections.find(
        (connection) => connection.id === primary.id,
      )?.isDefault,
      false,
    );

    const effectiveResearch =
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: "tavily",
        userId,
      });
    assert.equal(effectiveResearch?.connectionId, research.id);
    assert.equal(
      effectiveResearch?.capabilities.some(
        (capability) => capability.runtimeName === "internet.usage",
      ),
      false,
    );
    await assert.rejects(
      projectAppService.saveProjectAppCapabilityPolicy({
        organizationId,
        projectId,
        appKey: "tavily",
        capabilityKey: "research",
        actorUserId: userId,
        enabled: true,
        approvalMode: "auto",
      }),
      /cannot broaden/u,
    );
    await projectAppService.attachProjectAppConnection({
      organizationId,
      projectId,
      appKey: "tavily",
      connectionId: primary.id,
      actorUserId: userId,
      scope: "shared",
      isDefault: true,
    });
    const effectivePrimary =
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: "tavily",
        userId,
      });
    assert.equal(effectivePrimary?.connectionId, primary.id);
    await projectAppService.setProjectAppEnabled({
      organizationId,
      projectId,
      appKey: "tavily",
      actorUserId: userId,
      enabled: false,
    });
    assert.equal(
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: "tavily",
        userId,
      }),
      null,
    );
    await projectAppService.setProjectAppEnabled({
      organizationId,
      projectId,
      appKey: "tavily",
      actorUserId: userId,
      enabled: true,
    });

    await appService.saveEnvironmentAppCapabilityGrant({
      organizationId,
      environmentId,
      appKey: "tavily",
      capabilityKey: "research",
      grant: {
        enabled: true,
        approvalMode: "ask",
        loggingMode: "metadata_only",
        rateLimitMode: "strict",
      },
    });
    const afterGrant = await appService.getEnvironmentAppConfiguration({
      organizationId,
      environmentId,
      appKey: "tavily",
    });
    assert.equal(
      afterGrant.capabilities.find(
        (capability) => capability.key === "research",
      )?.approvalMode,
      "ask",
    );

    const issuedAt = Math.floor(Date.now() / 1000);
    const ticket: EnvironmentExecutionTicket = {
      version: 1,
      audience: "kestrel-environment-router",
      organizationId,
      environmentId,
      workspaceId,
      threadId,
      runId,
      actorId: userId,
      agentId: "kestrel-one",
      flyAppName: "apps-runtime-test",
      flyMachineId: "apps-runtime-test",
      capabilities: ["kestrel.tools.invoke"],
      issuedAt,
      expiresAt: issuedAt + 300,
      nonce: crypto.randomUUID(),
    };
    const authorizedSearch = await tavilyRuntime.authorizeTavilyRuntime({
      ticket,
      capability: "search",
      approval: "auto",
    });
    assert.equal(authorizedSearch.connectionId, primary.id);
    assert.deepEqual(authorizedSearch.credential, {
      kind: "api_key",
      apiKey: "tvly-replacement-secret",
    });
    await assert.rejects(
      tavilyRuntime.authorizeTavilyRuntime({
        ticket,
        capability: "research",
        approval: "auto",
      }),
      (error: unknown) =>
        error instanceof tavilyRuntime.TavilyRuntimeError &&
        error.code === "TAVILY_APPROVAL_REQUIRED" &&
        error.status === 409,
    );
    const authorizedResearch = await tavilyRuntime.authorizeTavilyRuntime({
      ticket,
      capability: "research",
      approval: "confirmed",
    });
    assert.equal(authorizedResearch.connectionId, primary.id);
    assert.equal(authorizedResearch.capability.approvalMode, "ask");

    const ngrokConnection = await appService.saveEnvironmentAppConnection({
      organizationId,
      environmentId,
      appKey: "ngrok",
      actorUserId: userId,
      connection: {
        kind: "ngrok_agent",
        name: "Environment previews",
        authtoken: "ngrok-test-token",
        wildcardDomain: `*.p-${suffix}.previews.example.test`,
      },
    });
    await projectAppService.setProjectAppEnabled({
      organizationId,
      projectId,
      appKey: "ngrok",
      actorUserId: userId,
      enabled: true,
    });
    await projectAppService.attachProjectAppConnection({
      organizationId,
      projectId,
      appKey: "ngrok",
      connectionId: ngrokConnection.id,
      actorUserId: userId,
      scope: "shared",
      isDefault: true,
    });
    await sql`
      UPDATE "environments"
      SET "router_url" = 'https://environment-gateway.example.test'
      WHERE "id" = ${environmentId}
    `;
    const publishPolicy = await appRuntime.authorizeAppRuntime({
      ticket,
      appKey: "ngrok",
      capabilityKey: "publish",
      approval: "auto",
    });
    const invokePreview = (input: {
      capability: "publish" | "list" | "renew" | "close";
      method: string;
      path: string[];
      body?: unknown;
    }) =>
      ngrokPreviewLifecycle.handleNgrokPreviewLifecycle({
        request: new Request("https://kestrel.example.test/runtime", {
          method: input.method,
          headers: { authorization: "Bearer workspace-ticket" },
          ...(input.body === undefined
            ? {}
            : {
                body: JSON.stringify(input.body),
                headers: {
                  authorization: "Bearer workspace-ticket",
                  "content-type": "application/json",
                },
              }),
        }),
        path: input.path,
        capability: input.capability,
        authorization: "Bearer workspace-ticket",
        ticket,
        policy: publishPolicy,
      });

    let failNextGatewayRefresh = true;
    globalThis.fetch = (async (request) => {
      const url = String(request);
      if (url.endsWith("/internal/config/refresh") && failNextGatewayRefresh) {
        failNextGatewayRefresh = false;
        return new Response("gateway unavailable", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      invokePreview({
        capability: "publish",
        method: "POST",
        path: ["previews"],
        body: { port: 40_999 },
      }),
      (error: unknown) =>
        error instanceof appRuntime.AppRuntimeError &&
        error.code === "WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE",
    );
    const [failedActivation] = await sql<Array<{
      id: string;
      status: string;
      failureCode: string | null;
      closedAt: Date | null;
    }>>`
      SELECT "id", "status", "failure_code" AS "failureCode", "closed_at" AS "closedAt"
      FROM "workspace_preview_leases"
      WHERE "workspace_id" = ${workspaceId} AND "port" = 40999
      ORDER BY "created_at" DESC
      LIMIT 1
    `;
    assert.equal(failedActivation?.status, "failed");
    assert.equal(failedActivation?.failureCode, "WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE");
    assert.notEqual(failedActivation?.closedAt, null);
    const recoveredActivation = await invokePreview({
      capability: "publish",
      method: "POST",
      path: ["previews"],
      body: { port: 40_999 },
    });
    const recoveredActivationBody = await recoveredActivation.json() as {
      preview: { id: string; status: string };
    };
    assert.notEqual(recoveredActivationBody.preview.id, failedActivation?.id);
    assert.equal(recoveredActivationBody.preview.status, "available");
    await invokePreview({
      capability: "close",
      method: "DELETE",
      path: ["previews", recoveredActivationBody.preview.id],
    });

    const concurrentPublishes = await Promise.allSettled(
      [41_001, 41_002, 41_003, 41_004, 41_005, 41_006].map((port) =>
        invokePreview({
          capability: "publish",
          method: "POST",
          path: ["previews"],
          body: { port },
        }),
      ),
    );
    assert.equal(
      concurrentPublishes.filter((result) => result.status === "fulfilled")
        .length,
      5,
    );
    assert.equal(
      concurrentPublishes.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof appRuntime.AppRuntimeError &&
          result.reason.code === "WORKSPACE_PREVIEW_LIMIT_REACHED",
      ).length,
      1,
    );
    const activePreviews = await sql<
      Array<{ id: string; port: number; status: string; expiresAt: Date }>
    >`
      SELECT "id", "port", "status", "expires_at" AS "expiresAt"
      FROM "workspace_preview_leases"
      WHERE "workspace_id" = ${workspaceId}
        AND "status" IN ('provisioning', 'active', 'closing')
      ORDER BY "port"
    `;
    assert.equal(activePreviews.length, 5);
    assert.deepEqual(
      activePreviews.map((preview) => preview.status),
      ["active", "active", "active", "active", "active"],
    );

    await sql`
      UPDATE "workspace_preview_leases"
      SET "expires_at" = ${new Date(Date.now() - 1_000)}
      WHERE "id" = ${activePreviews[4]!.id}
    `;
    const listed = await invokePreview({
      capability: "list",
      method: "GET",
      path: ["previews"],
    });
    const listedBody = (await listed.json()) as {
      previews: Array<{ id: string }>;
    };
    assert.equal(listedBody.previews.length, 4);
    assert.equal(
      listedBody.previews.some(
        (preview) => preview.id === activePreviews[4]!.id,
      ),
      false,
    );
    const [expiredPreview] = await sql<Array<{ status: string }>>`
      SELECT "status" FROM "workspace_preview_leases"
      WHERE "id" = ${activePreviews[4]!.id}
    `;
    assert.equal(expiredPreview?.status, "expired");

    const renewed = await invokePreview({
      capability: "renew",
      method: "POST",
      path: ["previews", activePreviews[0]!.id],
      body: { ttlMinutes: 120 },
    });
    const renewedBody = (await renewed.json()) as {
      preview: { id: string; expiresAt: string };
    };
    assert.equal(renewedBody.preview.id, activePreviews[0]!.id);
    assert.ok(
      new Date(renewedBody.preview.expiresAt).getTime() >
        activePreviews[0]!.expiresAt.getTime(),
    );

    failNextGatewayRefresh = true;
    globalThis.fetch = (async (request) => {
      const url = String(request);
      if (url.endsWith("/internal/config/refresh") && failNextGatewayRefresh) {
        failNextGatewayRefresh = false;
        return new Response("gateway unavailable", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      invokePreview({
        capability: "close",
        method: "DELETE",
        path: ["previews", activePreviews[0]!.id],
      }),
      (error: unknown) =>
        error instanceof appRuntime.AppRuntimeError &&
        error.code === "WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE",
    );
    const [closingPreview] = await sql<Array<{ status: string }>>`
      SELECT "status" FROM "workspace_preview_leases"
      WHERE "id" = ${activePreviews[0]!.id}
    `;
    assert.equal(closingPreview?.status, "closing");
    await invokePreview({
      capability: "close",
      method: "DELETE",
      path: ["previews", activePreviews[0]!.id],
    });
    const [closedPreview] = await sql<Array<{ status: string }>>`
      SELECT "status" FROM "workspace_preview_leases"
      WHERE "id" = ${activePreviews[0]!.id}
    `;
    assert.equal(closedPreview?.status, "closed");

    const samePortPublishes = await Promise.all([
      invokePreview({
        capability: "publish",
        method: "POST",
        path: ["previews"],
        body: { port: 41_100 },
      }),
      invokePreview({
        capability: "publish",
        method: "POST",
        path: ["previews"],
        body: { port: 41_100 },
      }),
    ]);
    const samePortBodies = await Promise.all(
      samePortPublishes.map(
        (response) =>
          response.json() as Promise<{
            preview: { id: string };
          }>,
      ),
    );
    assert.equal(samePortBodies[0]!.preview.id, samePortBodies[1]!.preview.id);
    const samePortRows = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS "count"
      FROM "workspace_preview_leases"
      WHERE "workspace_id" = ${workspaceId}
        AND "port" = 41100
        AND "status" IN ('provisioning', 'active', 'closing')
    `;
    assert.equal(samePortRows[0]?.count, "1");

    await sql`
      UPDATE "environments"
      SET "gateway_service_token_hash" = ${environmentServiceTokens.hashEnvironmentServiceToken("gateway-service-token")}
      WHERE "id" = ${environmentId}
    `;
    await sql`
      UPDATE "workspace_preview_leases"
      SET "status" = 'provisioning'
      WHERE "id" = ${samePortBodies[0]!.preview.id}
    `;
    await environmentGatewayConfig.reportEnvironmentGatewayNgrokStatus({
      environmentId,
      authorization: "Bearer gateway-service-token",
      connectionId: ngrokConnection.id,
      status: "degraded",
      failureCode: "NGROK_AGENT_ENDPOINT_FAILED",
      failureMessage: "authentication failed",
    });
    const [degradedConnection] = await sql<Array<{
      status: string;
      failureCode: string | null;
      failureMessage: string | null;
    }>>`
      SELECT "status", "failure_code" AS "failureCode", "failure_message" AS "failureMessage"
      FROM "app_connections"
      WHERE "id" = ${ngrokConnection.id}
    `;
    assert.deepEqual(degradedConnection, {
      status: "degraded",
      failureCode: "NGROK_AGENT_ENDPOINT_FAILED",
      failureMessage: "authentication failed",
    });
    const [failedProvisioningLease] = await sql<Array<{
      status: string;
      failureCode: string | null;
      closedAt: Date | null;
    }>>`
      SELECT "status", "failure_code" AS "failureCode", "closed_at" AS "closedAt"
      FROM "workspace_preview_leases"
      WHERE "id" = ${samePortBodies[0]!.preview.id}
    `;
    assert.equal(failedProvisioningLease?.status, "failed");
    assert.equal(failedProvisioningLease?.failureCode, "WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE");
    assert.notEqual(failedProvisioningLease?.closedAt, null);
    await environmentGatewayConfig.reportEnvironmentGatewayNgrokStatus({
      environmentId,
      authorization: "Bearer gateway-service-token",
      connectionId: ngrokConnection.id,
      status: "connected",
    });
    const [healthyConnection] = await sql<Array<{
      status: string;
      failureCode: string | null;
      failureMessage: string | null;
    }>>`
      SELECT "status", "failure_code" AS "failureCode", "failure_message" AS "failureMessage"
      FROM "app_connections"
      WHERE "id" = ${ngrokConnection.id}
    `;
    assert.deepEqual(healthyConnection, {
      status: "connected",
      failureCode: null,
      failureMessage: null,
    });
    const replacementPublish = await invokePreview({
      capability: "publish",
      method: "POST",
      path: ["previews"],
      body: { port: 41_100 },
    });
    const replacementBody = await replacementPublish.json() as {
      preview: { id: string; status: string };
    };
    assert.notEqual(replacementBody.preview.id, samePortBodies[0]!.preview.id);
    assert.equal(replacementBody.preview.status, "available");

    failNextGatewayRefresh = true;
    await assert.rejects(
      appService.disconnectEnvironmentAppConnection({
        organizationId,
        environmentId,
        appKey: "ngrok",
        connectionId: ngrokConnection.id,
      }),
      /Environment gateway refresh failed \(503\)/u,
    );
    const previewsAwaitingDisconnect = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS "count"
      FROM "workspace_preview_leases"
      WHERE "connection_id" = ${ngrokConnection.id}
        AND "status" = 'closing'
    `;
    assert.equal(previewsAwaitingDisconnect[0]?.count, "4");
    assert.equal(
      await environmentReconcile.reconcileClosingWorkspacePreviews(),
      4,
    );
    const remainingNgrokPreviews = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS "count"
      FROM "workspace_preview_leases"
      WHERE "connection_id" = ${ngrokConnection.id}
        AND "status" IN ('provisioning', 'active', 'closing')
    `;
    assert.equal(remainingNgrokPreviews[0]?.count, "0");
    await appRuntime.markAppConnectionHealthy({
      organizationId,
      environmentId,
      appKey: "ngrok",
      connectionId: ngrokConnection.id,
    });
    const [disconnectedNgrok] = await sql<Array<{ status: string }>>`
      SELECT "status" FROM "app_connections"
      WHERE "id" = ${ngrokConnection.id}
    `;
    assert.equal(disconnectedNgrok?.status, "disconnected");

    await sql`
      UPDATE "app_connections" connection
      SET "status" = 'degraded'
      WHERE connection."id" = ${ngrokConnection.id}
    `;
    await sql`
      UPDATE "app_credentials" credential
      SET "status" = 'active', "encrypted_payload" = 'kapp:v1:invalid',
          "revoked_at" = NULL
      FROM "app_connections" connection
      WHERE connection."id" = ${ngrokConnection.id}
        AND credential."id" = connection."credential_id"
    `;
    await sql`
      UPDATE "environments"
      SET
        "fly_app_name" = 'apps-runtime-test',
        "gateway_service_token_hash" = ${environmentServiceTokens.hashEnvironmentServiceToken("gateway-service-token")}
      WHERE "id" = ${environmentId}
    `;
    const configWithoutBrokenNgrok =
      await environmentGatewayConfig.resolveEnvironmentGatewayConfig({
        environmentId,
        authorization: "Bearer gateway-service-token",
      });
    assert.equal(configWithoutBrokenNgrok.ngrok, null);
    const [degradedBrokenNgrok] = await sql<
      Array<{ status: string; failureCode: string | null }>
    >`
      SELECT "status", "failure_code" AS "failureCode"
      FROM "app_connections"
      WHERE "id" = ${ngrokConnection.id}
    `;
    assert.deepEqual(degradedBrokenNgrok, {
      status: "degraded",
      failureCode: "NGROK_CREDENTIAL_UNAVAILABLE",
    });

    await appService.setAppInstallation({
      organizationId,
      appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
      actorUserId: userId,
      installed: true,
    });
    for (const capabilityKey of googleContract.GOOGLE_CALENDAR_CAPABILITIES) {
      const approvalMode =
        googleContract.GOOGLE_CALENDAR_WRITE_CAPABILITIES.some(
          (candidate) => candidate === capabilityKey,
        )
          ? "ask"
          : "auto";
      await appService.saveEnvironmentAppCapabilityGrant({
        organizationId,
        environmentId,
        appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
        capabilityKey,
        grant: {
          enabled: true,
          approvalMode,
          loggingMode: "metadata_only",
          rateLimitMode: "strict",
        },
      });
    }
    globalThis.fetch = (async (request) => {
      const url = String(request);
      if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
        return Response.json({
          sub: googleProviderAccountId,
          email: `${userId}@example.test`,
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const googleConnection = await googleOauth.syncGoogleCalendarUserConnection(
      {
        organizationId,
        projectId,
        userId,
        authAccountId: googleAuthAccountId,
        providerAccountId: googleProviderAccountId,
        accessToken: "google-access-token-not-persisted",
        scopes: [...googleContract.GOOGLE_CALENDAR_SCOPES],
        shareAvailability: true,
      },
    );
    const googleAccess =
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
        userId,
      });
    assert.equal(googleAccess?.connectionId, googleConnection.id);
    assert.equal(googleAccess?.capabilities.length, 6);
    const googleLegacyWrites = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS "count"
      FROM "user_tool_connections"
      WHERE "id" = ${googleConnection.id}
    `;
    assert.equal(googleLegacyWrites[0]?.count, "0");
    const authorizedCalendarRead =
      await googlePolicy.authorizeGoogleCalendarCapability({
        ticket,
        capability: "calendar.events.read",
        requireRunExecution: true,
      });
    assert.equal(authorizedCalendarRead.connection.id, googleConnection.id);
    assert.equal(authorizedCalendarRead.approvalMode, "auto");
    const authorizedCalendarWrite =
      await googlePolicy.authorizeGoogleCalendarCapability({
        ticket,
        capability: "calendar.events.create",
        requireRunExecution: true,
      });
    assert.equal(authorizedCalendarWrite.approvalMode, "ask");
    const [availabilitySharing] = await sql<
      Array<{ enabled: boolean; audience: string }>
    >`
      SELECT "enabled", "audience"
      FROM "project_app_user_capabilities"
      WHERE "project_id" = ${projectId}
        AND "connection_id" = ${googleConnection.id}
        AND "capability_key" = 'calendar.availability.read'
        AND "audience" = 'project'
    `;
    assert.deepEqual(availabilitySharing, {
      enabled: true,
      audience: "project",
    });
    await googleOauth.disconnectGoogleCalendarFromProject({
      organizationId,
      projectId,
      userId,
    });
    assert.equal(
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
        userId,
      }),
      null,
    );

    await appService.setAppInstallation({
      organizationId,
      appKey: microsoftContract.MICROSOFT_365_PROVIDER_KEY,
      actorUserId: userId,
      installed: true,
    });
    for (const capabilityKey of microsoftContract.MICROSOFT_365_CAPABILITIES) {
      await appService.saveEnvironmentAppCapabilityGrant({
        organizationId,
        environmentId,
        appKey: microsoftContract.MICROSOFT_365_PROVIDER_KEY,
        capabilityKey,
        grant: {
          enabled: true,
          approvalMode: microsoftContract.requiresMicrosoft365Approval(
            capabilityKey,
          )
            ? "ask"
            : "auto",
          loggingMode: "metadata_only",
          rateLimitMode: "strict",
        },
      });
    }
    globalThis.fetch = (async (request) => {
      if (String(request).includes("graph.microsoft.com/oidc/userinfo")) {
        return Response.json({
          sub: microsoftProviderAccountId,
          name: "Microsoft User",
          email: `${userId}@example.test`,
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const microsoftConnection = await microsoftOauth.syncMicrosoft365Connection(
      {
        organizationId,
        userId,
        authAccountId: microsoftAuthAccountId,
        providerAccountId: microsoftProviderAccountId,
        accessToken: "microsoft-access-token-not-persisted",
        scopes: microsoftContract.scopesForMicrosoft365Packs(["outlook"]),
        packs: ["outlook"],
      },
    );
    await projectAppService.attachProjectAppConnection({
      organizationId,
      projectId,
      appKey: microsoftContract.MICROSOFT_365_PROVIDER_KEY,
      connectionId: microsoftConnection.id,
      actorUserId: userId,
      scope: "personal",
      isDefault: true,
    });
    const microsoftAccess =
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: microsoftContract.MICROSOFT_365_PROVIDER_KEY,
        userId,
      });
    assert.equal(microsoftAccess?.connectionId, microsoftConnection.id);
    assert.deepEqual(
      microsoftAccess?.capabilities.map((capability) => capability.key).sort(),
      ["outlook.calendar.read", "outlook.mail.read", "outlook.mail.send"],
    );

    await appService.setAppInstallation({
      organizationId,
      appKey: "linear",
      actorUserId: userId,
      installed: true,
    });
    const linearConnectionSummary =
      await officialRemoteConnection.connectOfficialRemoteTokenApp({
        organizationId,
        environmentId,
        actorUserId: userId,
        appKey: "linear",
        connection: {
          name: "Primary",
          apiKey: "lin_api_first",
        },
      });
    assert.ok(linearConnectionSummary);
    const rotatedLinearConnection =
      await officialRemoteConnection.connectOfficialRemoteTokenApp({
        organizationId,
        environmentId,
        actorUserId: userId,
        appKey: "linear",
        connection: {
          name: "Primary",
          apiKey: "lin_api_rotated",
        },
      });
    assert.equal(rotatedLinearConnection?.id, linearConnectionSummary.id);
    const [linearCredentialCounts] = await sql<
      Array<{ active: number; revoked: number }>
    >`
      SELECT
        count(*) FILTER (WHERE "status" = 'active')::int AS "active",
        count(*) FILTER (WHERE "status" = 'revoked')::int AS "revoked"
      FROM "mcp_credentials"
      WHERE "environment_id" = ${environmentId}
    `;
    assert.deepEqual(linearCredentialCounts, { active: 1, revoked: 1 });
    const linearDetail = await mcpControl.getEnvironmentMcpServer({
      organizationId,
      environmentId,
      serverId: linearConnectionSummary.id,
    });
    assert.ok(linearDetail);
    const linearServer = linearDetail.server;
    assert.notEqual(linearServer.providerKey, "linear");
    const [linearConnection] = await sql<Array<{ appKey: string }>>`
      SELECT "app_key" AS "appKey"
      FROM "app_connections"
      WHERE "id" = ${linearServer.id}
    `;
    assert.equal(linearConnection?.appKey, "linear");
    await sql`
      INSERT INTO "tool_capabilities" (
        "provider_key", "key", "runtime_name", "display_name", "description",
        "access_mode", "default_enabled", "default_approval_mode",
        "default_surface_access", "default_rate_limit_mode", "default_logging_mode",
        "default_settings", "metadata", "created_at", "updated_at"
      ) VALUES (
        ${linearServer.providerKey}, 'tool.issue.create', 'mcp.linear.issue.create',
        'Create issue', 'Create an issue in Linear.', 'write', false, 'deny',
        ${sql.json({ chat: true, admin: false })}, 'default', 'full',
        ${sql.json({})}, ${sql.json({})}, ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "mcp_capability_snapshots" (
        "id", "server_id", "protocol_version", "capability_digest", "server_info",
        "status", "discovered_at", "created_at"
      ) VALUES (
        ${linearSnapshotId}, ${linearServer.id}, '2025-11-25',
        ${`sha256:${"2".repeat(64)}`}, ${sql.json({ name: "Linear" })},
        'pending_review', ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "mcp_capabilities" (
        "id", "snapshot_id", "provider_key", "tool_capability_key", "kind",
        "capability_key", "display_name", "description", "definition",
        "environment_enabled", "approval_mode", "created_at", "updated_at"
      ) VALUES (
        ${linearCapabilityId}, ${linearSnapshotId}, ${linearServer.providerKey},
        'tool.issue.create', 'tool', 'issue.create', 'Create issue',
        'Create an issue in Linear.',
        ${sql.json({ name: "issue.create", inputSchema: { type: "object" } })},
        false, 'deny', ${now}, ${now}
      )
    `;
    const linearBeforeReview = await appService.getEnvironmentAppConfiguration({
      organizationId,
      environmentId,
      appKey: "linear",
    });
    assert.deepEqual(
      linearBeforeReview.capabilityReviews.map((review) => ({
        connectionId: review.connectionId,
        snapshotId: review.snapshotId,
        capabilityKeys: review.capabilities.map((capability) => capability.key),
      })),
      [
        {
          connectionId: linearServer.id,
          snapshotId: linearSnapshotId,
          capabilityKeys: ["tool:issue.create"],
        },
      ],
    );
    await mcpControl.reviewEnvironmentMcpSnapshot({
      organizationId,
      environmentId,
      serverId: linearServer.id,
      snapshotId: linearSnapshotId,
      actorUserId: userId,
      decision: "approve",
    });
    const linearAfterReview = await appService.getEnvironmentAppConfiguration({
      organizationId,
      environmentId,
      appKey: "linear",
    });
    assert.equal(linearAfterReview.capabilityReviews.length, 0);
    assert.deepEqual(
      linearAfterReview.capabilities.map((capability) => ({
        key: capability.key,
        runtimeName: capability.runtimeName,
        enabled: capability.enabled,
      })),
      [
        {
          key: `mcp:${linearCapabilityId}`,
          runtimeName: `mcp.app.linear.mcp%3A${linearCapabilityId}`,
          enabled: false,
        },
      ],
    );
    await appService.setAppInstallation({
      organizationId: isolatedOrganizationId,
      appKey: "linear",
      actorUserId: isolatedUserId,
      installed: true,
    });
    const isolatedLinearConfiguration =
      await appService.getEnvironmentAppConfiguration({
        organizationId: isolatedOrganizationId,
        environmentId: isolatedEnvironmentId,
        appKey: "linear",
      });
    assert.deepEqual(isolatedLinearConfiguration.capabilities, []);
    const isolatedCatalog = await appService.listAppsForOrganization({
      organizationId: isolatedOrganizationId,
      userId: isolatedUserId,
      canManageOrganization: true,
    });
    assert.equal(
      isolatedCatalog.apps.find((app) => app.key === "linear")
        ?.capabilityCount,
      0
    );
    await mcpControl.disableEnvironmentMcpServer({
      organizationId,
      environmentId,
      serverId: linearServer.id,
      actorUserId: userId,
    });

    await appService.setAppInstallation({
      organizationId,
      appKey: "atlassian",
      actorUserId: userId,
      installed: true,
    });
    const atlassianConnection =
      await officialRemoteConnection.connectOfficialRemoteTokenApp({
        organizationId,
        environmentId,
        actorUserId: userId,
        appKey: "atlassian",
        connection: {
          name: "Delivery",
          apiKey: "atlassian_service_key_not_persisted",
        },
      });
    assert.ok(atlassianConnection);
    const atlassianDetail = await mcpControl.getEnvironmentMcpServer({
      organizationId,
      environmentId,
      serverId: atlassianConnection.id,
    });
    assert.ok(atlassianDetail);
    assert.equal(
      atlassianDetail.server.remoteUrl,
      "https://mcp.atlassian.com/v1/mcp",
    );
    const [atlassianConnectionRow] = await sql<Array<{ appKey: string }>>`
      SELECT "app_key" AS "appKey"
      FROM "app_connections"
      WHERE "id" = ${atlassianConnection.id}
    `;
    assert.equal(atlassianConnectionRow?.appKey, "atlassian");

    const customServer = await mcpControl.installEnvironmentMcpServer({
      organizationId,
      environmentId,
      actorUserId: userId,
      server: {
        name: "Design System",
        slug: "design-system",
        sourceType: "remote",
        transport: "streamable_http",
        remoteUrl: "https://mcp.example.test/rpc",
        auth: { mode: "none" },
        launchArguments: [],
        egressAllowlist: ["https://mcp.example.test"],
        resources: {
          cpuMillicores: 500,
          memoryMib: 512,
          pidsLimit: 128,
        },
      },
    });
    await sql`
      INSERT INTO "tool_capabilities" (
        "provider_key", "key", "runtime_name", "display_name", "description",
        "access_mode", "default_enabled", "default_approval_mode",
        "default_surface_access", "default_rate_limit_mode", "default_logging_mode",
        "default_settings", "metadata", "created_at", "updated_at"
      ) VALUES (
        ${customServer.providerKey}, 'tool.find_component', 'mcp.find_component',
        'Find component', 'Find a component in the design system.', 'read', false,
        'deny', ${sql.json({ chat: true, admin: false })}, 'default', 'full',
        ${sql.json({})}, ${sql.json({})}, ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "mcp_capability_snapshots" (
        "id", "server_id", "protocol_version", "capability_digest", "server_info",
        "status", "discovered_at", "created_at"
      ) VALUES (
        ${mcpSnapshotId}, ${customServer.id}, '2025-11-25',
        ${`sha256:${"1".repeat(64)}`}, ${sql.json({ name: "Design System" })},
        'pending_review', ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "mcp_capabilities" (
        "id", "snapshot_id", "provider_key", "tool_capability_key", "kind",
        "capability_key", "display_name", "description", "definition",
        "environment_enabled", "approval_mode", "created_at", "updated_at"
      ) VALUES (
        ${mcpCapabilityId}, ${mcpSnapshotId}, ${customServer.providerKey},
        'tool.find_component', 'tool', 'find_component', 'Find component',
        'Find a component in the design system.',
        ${sql.json({ name: "find_component", inputSchema: { type: "object" } })},
        false, 'deny', ${now}, ${now}
      )
    `;
    await mcpControl.reviewEnvironmentMcpSnapshot({
      organizationId,
      environmentId,
      serverId: customServer.id,
      snapshotId: mcpSnapshotId,
      actorUserId: userId,
      decision: "approve",
    });
    await mcpControl.setEnvironmentMcpCapabilityPolicy({
      organizationId,
      environmentId,
      capabilityId: mcpCapabilityId,
      actorUserId: userId,
      enabled: true,
      approvalMode: "auto",
    });
    await projectAppService.attachProjectAppConnection({
      organizationId,
      projectId,
      appKey: customServer.providerKey,
      connectionId: customServer.id,
      actorUserId: userId,
      scope: "shared",
      isDefault: true,
    });
    await projectAppService.saveProjectAppCapabilityPolicy({
      organizationId,
      projectId,
      appKey: customServer.providerKey,
      capabilityKey: `mcp:${mcpCapabilityId}`,
      actorUserId: userId,
      enabled: true,
      approvalMode: "ask",
    });
    const mcpContext = await mcpGrant.issueHostedMcpRunContext({
      runExecutionId: runId,
      organizationId,
      environmentId,
      projectId,
      threadId,
      gatewayUrl: "https://mcp-gateway.example.test",
    });
    assert.ok(mcpContext?.grantId);
    const [mcpRunGrant] = await sql<
      Array<{
        effectiveCapabilities: string[];
        effectivePolicy: Array<{
          capabilityId: string;
          approvalMode: string;
        }>;
      }>
    >`
      SELECT
        "effective_capabilities" AS "effectiveCapabilities",
        "effective_policy" AS "effectivePolicy"
      FROM "mcp_run_grants"
      WHERE "id" = ${mcpContext?.grantId ?? ""}
    `;
    assert.deepEqual(mcpRunGrant, {
      effectiveCapabilities: [mcpCapabilityId],
      effectivePolicy: [{ capabilityId: mcpCapabilityId, approvalMode: "ask" }],
    });
    await mcpControl.disableEnvironmentMcpServer({
      organizationId,
      environmentId,
      serverId: customServer.id,
      actorUserId: userId,
    });
    assert.equal(
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: customServer.providerKey,
        userId,
      }),
      null,
    );

    await appService.setAppInstallation({
      organizationId,
      appKey: "tavily",
      actorUserId: userId,
      installed: false,
    });
    assert.equal(
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: "tavily",
        userId,
      }),
      null,
    );
    const retainedConnections = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS "count"
      FROM "app_connections"
      WHERE "organization_id" = ${organizationId}
        AND "app_key" = 'tavily'
    `;
    assert.equal(retainedConnections[0]?.count, "2");
    await appService.setAppInstallation({
      organizationId,
      appKey: "tavily",
      actorUserId: userId,
      installed: true,
    });
    assert.equal(
      (
        await projectAppService.resolveEffectiveProjectAppAccess({
          organizationId,
          projectId,
          appKey: "tavily",
          userId,
        })
      )?.connectionId,
      primary.id,
    );

    await appService.disconnectEnvironmentAppConnection({
      organizationId,
      environmentId,
      appKey: "tavily",
      connectionId: research.id,
    });
    await assert.rejects(
      appService.resolveEnvironmentAppCredential({
        organizationId,
        environmentId,
        appKey: "tavily",
        connectionId: research.id,
      }),
      /Active App connection not found/u,
    );

    await appService.setAppInstallation({
      organizationId,
      appKey: "github",
      actorUserId: userId,
      installed: true,
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/user/repos")
        ? [
            {
              full_name: "kestrel/apps-proof",
              default_branch: "main",
              private: true,
              html_url: "https://github.com/kestrel/apps-proof",
              permissions: { pull: true, push: true, admin: false },
            },
          ]
        : { login: "apps-proof-user" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const githubSync = await githubOauth.syncGithubUserConnection({
      organizationId,
      userId,
      authAccountId: githubAuthAccountId,
      providerAccountId: githubProviderAccountId,
      accessToken: "github-test-token",
      scopes: ["repo"],
    });
    assert.equal(githubSync.repositoryCount, 1);
    const githubAppState = await sql<
      Array<{
        ownerType: string;
        status: string;
        resourceCount: string;
      }>
    >`
      SELECT connection."owner_type" AS "ownerType",
             connection."status",
             count(resource."id")::text AS "resourceCount"
      FROM "app_connections" connection
      LEFT JOIN "app_connection_resources" resource
        ON resource."connection_id" = connection."id"
      WHERE connection."id" = ${githubSync.connection.id}
      GROUP BY connection."id"
    `;
    assert.deepEqual(githubAppState[0], {
      ownerType: "personal",
      status: "connected",
      resourceCount: "1",
    });
    const githubLegacyWrites = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS "count"
      FROM "user_tool_connections"
      WHERE "id" = ${githubSync.connection.id}
    `;
    assert.equal(githubLegacyWrites[0]?.count, "0");
    await githubOauth.disconnectGithubUserConnection({
      organizationId,
      userId,
    });
    const githubDisconnected = await sql<Array<{ status: string }>>`
      SELECT "status"
      FROM "app_connections"
      WHERE "id" = ${githubSync.connection.id}
    `;
    assert.equal(githubDisconnected[0]?.status, "disconnected");

    await appService.disconnectEnvironmentAppConnection({
      organizationId,
      environmentId,
      appKey: "atlassian",
      connectionId: atlassianConnection.id,
    });
    const [disconnectedAtlassian] = await sql<
      Array<{
        connectionStatus: string;
        serverStatus: string;
        credentialStatus: string;
      }>
    >`
      SELECT connection."status" AS "connectionStatus",
             server."status" AS "serverStatus",
             credential."status" AS "credentialStatus"
      FROM "app_connections" connection
      JOIN "mcp_servers" server ON server."id" = connection."id"
      JOIN "mcp_credentials" credential
        ON credential."id" = server."credential_id"
      WHERE connection."id" = ${atlassianConnection.id}
    `;
    assert.deepEqual(disconnectedAtlassian, {
      connectionStatus: "disconnected",
      serverStatus: "disabled",
      credentialStatus: "revoked",
    });

    const encryptedRows = await sql<
      Array<{ encrypted_payload: string; status: string }>
    >`
      SELECT "encrypted_payload", "status"
      FROM "app_credentials"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at"
    `;
    assert.ok(
      encryptedRows.every((row) =>
        row.encrypted_payload.startsWith("kapp:v1:"),
      ),
    );
    assert.ok(
      encryptedRows.every((row) => !row.encrypted_payload.includes("tvly-")),
    );
    assert.ok(encryptedRows.some((row) => row.status === "revoked"));
  },
);
