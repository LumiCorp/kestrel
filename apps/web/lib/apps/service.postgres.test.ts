import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test(
  "Environment Apps persist encrypted named connections and capability ceilings",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");
    process.env.KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
    process.env.KESTREL_APP_CREDENTIAL_KEYS = JSON.stringify({
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
      googleContract,
      googleOauth,
      googlePolicy,
      githubOauth,
      mcpControl,
      mcpGrant,
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("@/lib/environments/store"),
      import("./service"),
      import("./project-service"),
      import("./tavily-runtime"),
      import("@/lib/integrations/google-calendar-contract"),
      import("@/lib/integrations/google-calendar-oauth"),
      import("@/lib/integrations/google-calendar-policy"),
      import("@/lib/integrations/github-oauth"),
      import("@/lib/mcp/control-plane"),
      import("@/lib/mcp/grant-service"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const organizationId = `apps-org-${suffix}`;
    const userId = `apps-user-${suffix}`;
    const memberId = `apps-member-${suffix}`;
    const projectId = `apps-project-${suffix}`;
    const threadId = `apps-thread-${suffix}`;
    const workspaceId = `apps-workspace-${suffix}`;
    const runId = `apps-run-${suffix}`;
    const googleAuthAccountId = `apps-google-auth-${suffix}`;
    const googleProviderAccountId = `apps-google-provider-${suffix}`;
    const githubAuthAccountId = `apps-github-auth-${suffix}`;
    const githubProviderAccountId = `apps-github-provider-${suffix}`;
    const mcpSnapshotId = crypto.randomUUID();
    const mcpCapabilityId = crypto.randomUUID();
    const now = new Date();

    context.after(async () => {
      globalThis.fetch = originalFetch;
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
        ${githubAuthAccountId}, ${githubProviderAccountId}, 'github', ${userId},
        'repo', ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', ${now})
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
      (configuration) => configuration.app.key === "built_in.weather"
    );
    assert.equal(environmentWeather?.app.connectionModel, "environment");
    assert.equal(environmentWeather?.app.connectionRequirement, "optional");
    assert.equal(environmentWeather?.connections.length, 0);
    assert.equal(
      environmentWeather?.capabilities.find(
        (capability) => capability.key === "getWeather"
      )?.enabled,
      true
    );

    const initialProjectApps =
      await projectAppService.listProjectAppConfigurations({
        organizationId,
        projectId,
        userId,
      });
    const projectWeather = initialProjectApps.find(
      (configuration) => configuration.app.key === "built_in.weather"
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
      ]
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
      ["forecast"]
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
      "ask"
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
      null
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
      false
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
      (configuration) => configuration.app.key === "tavily"
    );
    assert.equal(projectTavily?.availableConnections.length, 2);
    assert.equal(
      projectTavily?.attachedConnections.find(
        (connection) => connection.id === research.id
      )?.isDefault,
      true
    );
    assert.equal(
      projectTavily?.attachedConnections.find(
        (connection) => connection.id === primary.id
      )?.isDefault,
      false
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
        (capability) => capability.runtimeName === "internet.usage"
      ),
      false
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
      /cannot broaden/u
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
      null
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
        (capability) => capability.key === "research"
      )?.approvalMode,
      "ask"
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
        error.status === 409
    );
    const authorizedResearch = await tavilyRuntime.authorizeTavilyRuntime({
      ticket,
      capability: "research",
      approval: "confirmed",
    });
    assert.equal(authorizedResearch.connectionId, primary.id);
    assert.equal(authorizedResearch.capability.approvalMode, "ask");

    await appService.setAppInstallation({
      organizationId,
      appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
      actorUserId: userId,
      installed: true,
    });
    for (const capabilityKey of googleContract.GOOGLE_CALENDAR_CAPABILITIES) {
      const approvalMode =
        googleContract.GOOGLE_CALENDAR_WRITE_CAPABILITIES.some(
          (candidate) => candidate === capabilityKey
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
      }
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
      null
    );

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
      capabilityKey: "tool:find_component",
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
      null
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
      null
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
      primary.id
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
      /Active App connection not found/u
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

    const encryptedRows = await sql<
      Array<{ encrypted_payload: string; status: string }>
    >`
      SELECT "encrypted_payload", "status"
      FROM "app_credentials"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at"
    `;
    assert.ok(
      encryptedRows.every((row) => row.encrypted_payload.startsWith("kapp:v1:"))
    );
    assert.ok(
      encryptedRows.every((row) => !row.encrypted_payload.includes("tvly-"))
    );
    assert.ok(encryptedRows.some((row) => row.status === "revoked"));
  }
);
