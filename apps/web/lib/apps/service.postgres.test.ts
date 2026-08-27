import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import { RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION } from "@kestrel-agents/protocol";
import postgres from "postgres";
import { installTestStableRuntimeBundle } from "@/lib/environments/test-runtime-channel";

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
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
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
      previewLifecycle,
      googleContract,
      googleOauth,
      googlePolicy,
      microsoftContract,
      microsoftOauth,
      githubOauth,
      officialRemoteConnection,
      mcpControl,
      mcpGrant,
      appApprovals,
      turnStore,
      runtimeApprovalPolicy,
      knowledgeDbModule,
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("@/lib/environments/store"),
      import("./service"),
      import("./project-service"),
      import("./tavily-runtime"),
      import("./runtime"),
      import("./preview-lifecycle"),
      import("@/lib/integrations/google-calendar-contract"),
      import("@/lib/integrations/google-calendar-oauth"),
      import("@/lib/integrations/google-calendar-policy"),
      import("@/lib/integrations/microsoft-365-contract"),
      import("@/lib/integrations/microsoft-365-oauth"),
      import("@/lib/integrations/github-oauth"),
      import("./official-remote-connection"),
      import("@/lib/mcp/control-plane"),
      import("@/lib/mcp/grant-service"),
      import("./app-operation-approvals"),
      import("@/lib/turns/store"),
      import("./runtime-approval-policy"),
      import("@/lib/knowledge/db"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const organizationId = `apps-org-${suffix}`;
    const userId = `apps-user-${suffix}`;
    const memberId = `apps-member-${suffix}`;
    const isolatedOrganizationId = `apps-isolated-org-${suffix}`;
    const isolatedUserId = `apps-isolated-user-${suffix}`;
    const isolatedMemberId = `apps-isolated-member-${suffix}`;
    const crossTenantMemberId = `apps-cross-tenant-member-${suffix}`;
    const projectId = `apps-project-${suffix}`;
    const threadId = `apps-thread-${suffix}`;
    const workspaceId = `apps-workspace-${suffix}`;
    const runId = `apps-run-${suffix}`;
    const replayRunId = `apps-replay-run-${suffix}`;
    const googleAuthAccountId = `apps-google-auth-${suffix}`;
    const googleProviderAccountId = `apps-google-provider-${suffix}`;
    const isolatedGoogleConnectionId = `apps-isolated-google-${suffix}`;
    const githubAuthAccountId = `apps-github-auth-${suffix}`;
    const githubProviderAccountId = `apps-github-provider-${suffix}`;
    const microsoftAuthAccountId = `apps-microsoft-auth-${suffix}`;
    const microsoftProviderAccountId = `apps-microsoft-provider-${suffix}`;
    const mcpSnapshotId = crypto.randomUUID();
    const mcpCapabilityId = crypto.randomUUID();
    const linearSnapshotId = crypto.randomUUID();
    const linearCapabilityId = crypto.randomUUID();
    const now = new Date();
    const removeStableRuntimeBundle = await installTestStableRuntimeBundle(
      databaseUrl,
      suffix,
    );

    context.after(async () => {
      globalThis.fetch = originalFetch;
      await sql`DELETE FROM "organization" WHERE "id" = ${isolatedOrganizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${isolatedUserId}`;
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await removeStableRuntimeBundle();
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
    await sql`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES (
        ${crossTenantMemberId}, ${isolatedOrganizationId}, ${userId},
        'member', ${now}
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

    const weatherFallback = await appService.saveEnvironmentAppConnection({
      organizationId,
      environmentId,
      appKey: "built_in.weather",
      actorUserId: userId,
      connection: {
        name: "Visual Crossing fallback",
        apiKey: "visual-crossing-fallback-secret",
      },
    });
    const weatherWithFallback = await appService.getEnvironmentAppConfiguration({
      organizationId,
      environmentId,
      appKey: "built_in.weather",
    });
    assert.deepEqual(weatherWithFallback.connections, [
      {
        id: weatherFallback.id,
        name: "Visual Crossing fallback",
        ownerType: "environment",
        status: "connected",
        environmentId,
        isMine: false,
        lastHealthAt: weatherFallback.lastHealthAt,
      },
    ]);
    assert.deepEqual(
      await appService.resolveEnvironmentAppCredential({
        organizationId,
        environmentId,
        appKey: "built_in.weather",
        connectionId: weatherFallback.id,
      }),
      {
        kind: "api_key",
        apiKey: "visual-crossing-fallback-secret",
      },
    );

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

    await sql`
      INSERT INTO "app_connection_resources" (
        "id", "connection_id", "external_id", "resource_type", "label",
        "enabled", "created_at", "updated_at"
      ) VALUES (
        ${`approval-resource-${suffix}`}, ${primary.id}, 'approval-integrity',
        'search_scope', 'Approval integrity fixture', true, ${now}, ${now}
      )
    `;
    const [approvalResource] = await sql<
      Array<{ id: string; resourceType: string }>
    >`
      SELECT "id", "resource_type" AS "resourceType"
      FROM "app_connection_resources"
      WHERE "connection_id" = ${primary.id} AND "enabled" = true
      ORDER BY "created_at"
      LIMIT 1
    `;
    assert.ok(approvalResource);
    const approvalBinding = {
      organizationId,
      environmentId,
      workspaceId,
      threadId,
      actorUserId: userId,
      agentId: "kestrel-one",
      appKey: "tavily",
      capabilityKey: "research",
      connectionId: primary.id,
      resourceId: approvalResource.id,
      resourceType: approvalResource.resourceType,
      operationKey: "tavily.research",
      runtimeApprovalId: `approval-${suffix}`,
      payload: { query: "approval integrity" },
    };
    const requestedApproval = await appApprovals.recordAppOperationApprovalRequest({
      binding: approvalBinding,
      projectId,
      requestedExecutionId: runId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.match(requestedApproval.authorityRevision ?? "", /^sha256:[0-9a-f]{64}$/u);
    assert.equal(requestedApproval.externalApprovalBinding?.authorityKind, "hosted_app_policy");
    const approvalTurnId = `approval-turn-${suffix}`;
    await sql`
      UPDATE "environment_run_executions"
      SET "status" = 'running', "runtime_run_id" = ${runId}, "started_at" = ${now}
      WHERE "id" = ${runId}
    `;
    await sql`
      INSERT INTO "thread_turns" (
        "id", "organization_id", "thread_id", "author_user_id",
        "approval_id", "approval_approved",
        "environment_execution_id", "requested_environment_id",
        "idempotency_key", "sequence", "queue_ordinal", "status"
      ) VALUES (
        ${approvalTurnId}, ${organizationId}, ${threadId}, ${userId},
        ${`turn-approval-${suffix}`}, true,
        ${runId}, ${environmentId}, ${`approval-turn-${suffix}`}, 1, 1, 'running'
      )
    `;
    const bindApprovalInteraction = async (
      runtimeApprovalId: string,
      approval: {
        toolName: string;
        preparedInvocationId?: string;
        stableToolIdentity?: {
          version: string;
          toolId: string;
          descriptorContractRevision: string;
          approvalAuthorityRevision: string;
        };
      } = { toolName: "tavily.research" },
    ) => {
      const requestId = `request-${runtimeApprovalId}`;
      const requestEnvelope = approval.preparedInvocationId
        ? {
            version: "runner_hosted_tool_approval_interaction_v2",
            requestId,
            kind: "approval",
            eventType: "user.approval",
            prompt: `Approve ${approval.toolName}?`,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["decision"],
              properties: {
                decision: {
                  type: "string",
                  enum: ["decline", "approve_once"],
                },
              },
            },
            approval: {
              ...approval,
              requestingActor: {
                actorType: "end_user",
                actorId: userId,
                tenantId: organizationId,
              },
            },
          }
        : { approval };
      await sql`
        INSERT INTO "thread_interactions" (
          "id", "request_id", "organization_id", "thread_id", "turn_id",
          "source", "kind", "event_type", "prompt", "status",
          "request_envelope", "response_envelope", "runtime_approval_id",
          "source_runtime_run_id", "resolved_by_user_id", "resolved_at", "resumed_at"
        ) VALUES (
          ${`interaction-${runtimeApprovalId}`}, ${requestId},
          ${organizationId}, ${threadId}, ${approvalTurnId}, 'runtime', 'approval',
          'user.approval', 'Approve?', ${approval.preparedInvocationId ? "processing" : "resolved"},
          ${sql.json(requestEnvelope)},
          ${sql.json(
            approval.preparedInvocationId
              ? { decision: "approve_once" }
              : { approved: true },
          )}, ${runtimeApprovalId}, ${runId},
          ${userId}, ${now}, ${now}
        )
      `;
      if (approval.preparedInvocationId) {
        await sql`
          UPDATE "app_operation_approvals"
          SET "interaction_id" = ${`interaction-${runtimeApprovalId}`}
          WHERE "organization_id" = ${organizationId}
            AND "runtime_approval_id" = ${runtimeApprovalId}
            AND "lifecycle_version" = 'interaction_v2'
        `;
      }
    };
    await sql`
      INSERT INTO "environment_run_executions" (
        "id", "organization_id", "environment_id", "workspace_id", "thread_id",
        "project_id", "actor_id", "runtime_image", "effective_capabilities"
      ) VALUES (
        ${replayRunId}, ${organizationId}, ${environmentId}, ${workspaceId}, ${threadId},
        ${projectId}, ${userId}, 'apps-runtime-test', ${sql.json([
          "app:tavily.search:auto",
          "app:tavily.research:ask",
        ])}
      )
    `;
    await sql`
      UPDATE "environment_run_executions"
      SET "status" = 'running', "runtime_run_id" = ${replayRunId}, "started_at" = ${now}
      WHERE "id" = ${replayRunId}
    `;
    await assert.rejects(
      appApprovals.recordAppOperationApprovalRequest({
        binding: approvalBinding,
        projectId,
        requestedExecutionId: replayRunId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      (error: unknown) =>
        error instanceof appApprovals.AppOperationApprovalError &&
        error.code === "APP_OPERATION_APPROVAL_BINDING_MISMATCH",
    );
    await assert.rejects(
      appApprovals.decideAppOperationApproval({
        organizationId,
        threadId,
        userId: isolatedUserId,
        runtimeApprovalId: approvalBinding.runtimeApprovalId,
        approved: true,
      }),
      (error: unknown) =>
        error instanceof appApprovals.AppOperationApprovalError &&
        error.code === "APP_OPERATION_APPROVAL_NOT_PENDING",
    );
    const approved = await appApprovals.decideAppOperationApproval({
      organizationId,
      threadId,
      userId,
      runtimeApprovalId: approvalBinding.runtimeApprovalId,
      approved: true,
    });
    const repeatedApproval = await appApprovals.decideAppOperationApproval({
      organizationId,
      threadId,
      userId,
      runtimeApprovalId: approvalBinding.runtimeApprovalId,
      approved: true,
    });
    assert.equal(repeatedApproval.id, approved.id);
    assert.equal(repeatedApproval.status, "approved");
    await bindApprovalInteraction(approvalBinding.runtimeApprovalId);
    const concurrentConsumption = await Promise.allSettled([
      appApprovals.consumeAppOperationApproval({
        binding: approvalBinding,
        consumedExecutionId: runId,
      }),
      appApprovals.consumeAppOperationApproval({
        binding: approvalBinding,
        consumedExecutionId: runId,
      }),
    ]);
    assert.deepEqual(
      concurrentConsumption.map((result) => result.status).sort(),
      ["fulfilled", "rejected"],
    );
    const consumedReplay = await appApprovals.decideAppOperationApproval({
      organizationId,
      threadId,
      userId,
      runtimeApprovalId: approvalBinding.runtimeApprovalId,
      approved: true,
    });
    assert.equal(consumedReplay.id, approved.id);
    assert.equal(consumedReplay.status, "consumed");

    const v2StableToolIdentity = {
      version: "stable_tool_approval_identity_v1" as const,
      toolId: "tavily.research",
      descriptorContractRevision: `sha256:${"d".repeat(64)}`,
      approvalAuthorityRevision: "approval-authority-v2",
    };
    const v2PreparedInvocationId = `prepared-${suffix}`;
    const v2ApprovalBinding = {
      ...approvalBinding,
      runtimeApprovalId: `approval-v2-${suffix}`,
      payload: { query: "V2 approval integrity" },
    };
    const v2RuntimeBinding = {
      version: RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
      approvalId: v2ApprovalBinding.runtimeApprovalId,
      preparedInvocationId: v2PreparedInvocationId,
      threadId,
      actionKey: "tavily.research",
      payloadHash: `sha256:${"e".repeat(64)}`,
      stableAuthorityFingerprint: `sha256:${"f".repeat(64)}`,
      stableToolIdentity: v2StableToolIdentity,
      requestingActor: {
        actorType: "end_user" as const,
        actorId: userId,
        tenantId: organizationId,
      },
      toolClass: "external_side_effect" as const,
      capabilities: ["external.confirm", "network.call"],
      authorityKind: "runtime_policy" as const,
      authorityRevision: "approval-authority-v2",
      requestedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const requestedV2Approval =
      await appApprovals.recordAppOperationApprovalRequest({
        binding: v2ApprovalBinding,
        projectId,
        requestedExecutionId: runId,
        expiresAt: new Date(Date.now() + 50_000),
        runtimeBinding: v2RuntimeBinding,
      });
    assert.equal(
      requestedV2Approval.externalApprovalBinding?.version,
      RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
    );
    assert.equal(requestedV2Approval.lifecycleVersion, "interaction_v2");
    assert.equal(requestedV2Approval.availabilityStatus, "available");
    assert.equal(requestedV2Approval.status, null);
    await bindApprovalInteraction(v2ApprovalBinding.runtimeApprovalId, {
      toolName: "tavily.research",
      preparedInvocationId: v2PreparedInvocationId,
      stableToolIdentity: v2StableToolIdentity,
    });
    const consumedV2 = await appApprovals.consumeAppOperationApproval({
      binding: v2ApprovalBinding,
      consumedExecutionId: runId,
    });
    assert.equal(consumedV2.status, null);
    assert.equal(consumedV2.availabilityStatus, "consumed");
    await sql`
      UPDATE "thread_turns"
      SET
        "approval_id" = NULL,
        "approval_approved" = NULL,
        "resume_interaction_id" = ${`interaction-${v2ApprovalBinding.runtimeApprovalId}`}
      WHERE "id" = ${approvalTurnId}
    `;
    assert.equal(
      await turnStore.recordDurableRuntimeToolOutcome({
        turnId: approvalTurnId,
        eventId: `v2-failed-before-effect-${suffix}`,
        outcome: {
          callId: v2PreparedInvocationId,
          kind: "failure",
          effectState: "not_started",
          retryable: true,
          normalizedFailureCode: "PROVIDER_FAILED_BEFORE_EFFECT",
        },
      }),
      true,
    );
    const [consumedFailure] = await sql<Array<{
      availabilityStatus: string;
      interactionStatus: string;
      responseRetryable: boolean;
    }>>`
      SELECT
        approval."availability_status" AS "availabilityStatus",
        interaction."status" AS "interactionStatus",
        interaction."response_retryable" AS "responseRetryable"
      FROM "app_operation_approvals" approval
      JOIN "thread_interactions" interaction
        ON interaction."id" = approval."interaction_id"
      WHERE approval."organization_id" = ${organizationId}
        AND approval."runtime_approval_id" = ${v2ApprovalBinding.runtimeApprovalId}
    `;
    assert.deepEqual(consumedFailure, {
      availabilityStatus: "consumed",
      interactionStatus: "failed",
      responseRetryable: false,
    });

    const expiringV2Binding = {
      ...v2ApprovalBinding,
      runtimeApprovalId: `approval-v2-expiring-${suffix}`,
      payload: { query: "V2 expiry redaction" },
    };
    const expiringV2RuntimeBinding = {
      ...v2RuntimeBinding,
      approvalId: expiringV2Binding.runtimeApprovalId,
      preparedInvocationId: `prepared-expiring-${suffix}`,
      requestedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await appApprovals.recordAppOperationApprovalRequest({
      binding: expiringV2Binding,
      projectId,
      requestedExecutionId: runId,
      expiresAt: new Date(Date.now() + 50_000),
      runtimeBinding: expiringV2RuntimeBinding,
    });
    await bindApprovalInteraction(expiringV2Binding.runtimeApprovalId, {
      toolName: "tavily.research",
      preparedInvocationId: expiringV2RuntimeBinding.preparedInvocationId,
      stableToolIdentity: v2StableToolIdentity,
    });
    await appApprovals.expireStaleAppOperationApprovals(
      new Date(Date.now() + 120_000),
    );
    const [expiredV2] = await sql<Array<{
      availabilityStatus: string;
      payload: Record<string, unknown>;
      interactionStatus: string;
      failureCode: string | null;
      effectStatus: string | null;
    }>>`
      SELECT
        approval."availability_status" AS "availabilityStatus",
        approval."payload",
        interaction."status" AS "interactionStatus",
        interaction."response_failure_code" AS "failureCode",
        interaction."effect_status" AS "effectStatus"
      FROM "app_operation_approvals" approval
      JOIN "thread_interactions" interaction
        ON interaction."id" = approval."interaction_id"
      WHERE approval."organization_id" = ${organizationId}
        AND approval."runtime_approval_id" = ${expiringV2Binding.runtimeApprovalId}
    `;
    assert.deepEqual(expiredV2, {
      availabilityStatus: "expired",
      payload: { redacted: true, operation: "tavily.research" },
      interactionStatus: "failed",
      failureCode: "EXTERNAL_APPROVAL_EXPIRED",
      effectStatus: "not_started",
    });

    const orphanedV2Binding = {
      ...v2ApprovalBinding,
      runtimeApprovalId: `approval-v2-orphaned-${suffix}`,
      payload: { query: "V2 orphan expiry" },
    };
    const orphanedV2RuntimeBinding = {
      ...v2RuntimeBinding,
      approvalId: orphanedV2Binding.runtimeApprovalId,
      preparedInvocationId: `prepared-orphaned-${suffix}`,
      requestedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await appApprovals.recordAppOperationApprovalRequest({
      binding: orphanedV2Binding,
      projectId,
      requestedExecutionId: runId,
      expiresAt: new Date(Date.now() + 50_000),
      runtimeBinding: orphanedV2RuntimeBinding,
    });
    const afterOrphanExpiry = new Date(Date.now() + 120_000);
    await appApprovals.expireStaleAppOperationApprovals(afterOrphanExpiry);
    await assert.rejects(
      knowledgeDbModule.knowledgeDb.transaction((tx) =>
        appApprovals.linkAppOperationApprovalToInteractionInTransaction(tx, {
          organizationId,
          threadId,
          runtimeApprovalId: orphanedV2Binding.runtimeApprovalId,
          interactionId: `interaction-after-expiry-${suffix}`,
          now: afterOrphanExpiry,
        }),
      ),
      (error: unknown) =>
        error instanceof appApprovals.AppOperationApprovalError &&
        error.code === "APP_OPERATION_APPROVAL_BINDING_MISMATCH",
    );

    const directlyApprovedBinding = {
      ...approvalBinding,
      runtimeApprovalId: `approval-direct-${suffix}`,
      payload: { query: "confirmed in the owning UI" },
    };
    const directlyApproved =
      await appApprovals.recordAppOperationApprovalRequest({
        binding: directlyApprovedBinding,
        projectId,
        requestedExecutionId: runId,
        expiresAt: new Date(Date.now() + 5 * 60_000),
        approvedByUserId: userId,
      });
    assert.equal(directlyApproved.status, "approved");
    assert.equal(directlyApproved.decidedByUserId, userId);
    await bindApprovalInteraction(directlyApprovedBinding.runtimeApprovalId);
    await assert.rejects(
      appApprovals.consumeAppOperationApproval({
        binding: directlyApprovedBinding,
        consumedExecutionId: replayRunId,
      }),
      (error: unknown) =>
        error instanceof appApprovals.AppOperationApprovalError &&
        error.code === "APP_OPERATION_APPROVAL_INVALID",
    );
    const directlyConsumed = await appApprovals.consumeAppOperationApproval({
      binding: directlyApprovedBinding,
      consumedExecutionId: runId,
    });
    assert.equal(directlyConsumed.status, "consumed");
    await assert.rejects(
      appApprovals.consumeAppOperationApproval({
        binding: directlyApprovedBinding,
        consumedExecutionId: runId,
      }),
      (error: unknown) =>
        error instanceof appApprovals.AppOperationApprovalError &&
        error.code === "APP_OPERATION_APPROVAL_INVALID",
    );

    const changedPolicyBinding = {
      ...approvalBinding,
      runtimeApprovalId: `approval-policy-${suffix}`,
      payload: { query: "policy revision" },
    };
    await appApprovals.recordAppOperationApprovalRequest({
      binding: changedPolicyBinding,
      projectId,
      requestedExecutionId: runId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await bindApprovalInteraction(changedPolicyBinding.runtimeApprovalId);
    await appApprovals.decideAppOperationApproval({
      organizationId,
      threadId,
      userId,
      runtimeApprovalId: changedPolicyBinding.runtimeApprovalId,
      approved: true,
    });
    await appService.saveEnvironmentAppCapabilityGrant({
      organizationId,
      environmentId,
      appKey: "tavily",
      capabilityKey: "research",
      grant: {
        enabled: true,
        approvalMode: "deny",
        loggingMode: "metadata_only",
        rateLimitMode: "strict",
      },
    });
    await assert.rejects(
      appApprovals.consumeAppOperationApproval({
        binding: changedPolicyBinding,
        consumedExecutionId: runId,
      }),
      (error: unknown) =>
        error instanceof appApprovals.AppOperationApprovalError &&
        error.code === "APP_OPERATION_APPROVAL_INVALID",
    );
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

    await projectAppService.setProjectAppEnabled({
      organizationId,
      projectId,
      appKey: "built_in.previews",
      actorUserId: userId,
      enabled: true,
    });
    await sql`
      UPDATE "environments"
      SET "router_url" = 'https://environment-gateway.example.test'
      WHERE "id" = ${environmentId}
    `;
    const publishPolicy = await appRuntime.authorizeAppRuntime({
      ticket,
      appKey: "built_in.previews",
      capabilityKey: "publish",
      approval: "auto",
    });
    const assertGatewayRefreshAuthorization = (init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      assert.match(authorization ?? "", /^Bearer /u);
      const credential = verifyEnvironmentToolCredential({
        token: authorization!.slice("Bearer ".length),
        publicKey: publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
      });
      assert.equal(credential.organizationId, organizationId);
      assert.equal(credential.environmentId, environmentId);
      assert.equal(credential.providerKey, "kestrel-control-plane");
      assert.equal(credential.resourceId, environmentId);
      assert.equal(credential.capability, "gateway.config.refresh");
      assert.equal(credential.operation, "refresh");
      assert.equal(credential.operationBinding, null);
    };
    const invokePreview = (input: {
      capability: "publish" | "list" | "renew" | "close";
      method: string;
      path: string[];
      body?: unknown;
    }) =>
      previewLifecycle.handlePreviewLifecycle({
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
    globalThis.fetch = (async (request, init) => {
      const url = String(request);
      if (url.endsWith("/internal/config/refresh")) {
        assertGatewayRefreshAuthorization(init);
        if (failNextGatewayRefresh) {
          failNextGatewayRefresh = false;
          return new Response("gateway unavailable", { status: 503 });
        }
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
    assert.equal("ingressProvider" in recoveredActivationBody.preview, false);
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
      SET "expires_at" = ${new Date(Date.now() - 1000)}
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
    globalThis.fetch = (async (request, init) => {
      const url = String(request);
      if (url.endsWith("/internal/config/refresh")) {
        assertGatewayRefreshAuthorization(init);
        if (failNextGatewayRefresh) {
          failNextGatewayRefresh = false;
          return new Response("gateway unavailable", { status: 503 });
        }
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

    await assert.rejects(
      appService.requireInstalledAppForOrganization({
        organizationId,
        appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
      }),
      (error: unknown) =>
        error instanceof appService.AppServiceError &&
        error.code === "APP_NOT_INSTALLED",
    );
    await appService.setAppInstallation({
      organizationId,
      appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
      actorUserId: userId,
      installed: true,
    });
    await appService.requireInstalledAppForOrganization({
      organizationId,
      appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
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
        userId,
        authAccountId: googleAuthAccountId,
        providerAccountId: googleProviderAccountId,
        accessToken: "google-access-token-not-persisted",
        scopes: [...googleContract.GOOGLE_CALENDAR_SCOPES],
      },
    );
    assert.equal(
      await projectAppService.resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
        userId,
      }),
      null,
    );
    await googleOauth.attachGoogleCalendarConnectionToProject({
      organizationId,
      projectId,
      userId,
      shareAvailability: true,
    });
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
    await appService.saveEnvironmentAppCapabilityGrant({
      organizationId,
      environmentId,
      appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
      capabilityKey: "calendar.events.create",
      grant: {
        enabled: true,
        approvalMode: "auto",
        loggingMode: "metadata_only",
        rateLimitMode: "strict",
      },
    });
    await projectAppService.saveProjectAppCapabilityPolicy({
      organizationId,
      projectId,
      appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
      capabilityKey: "calendar.events.create",
      actorUserId: userId,
      enabled: true,
      approvalMode: "ask",
    });
    const [rememberResource] = await sql<
      Array<{ id: string; resourceType: string }>
    >`
      SELECT "id", "resource_type" AS "resourceType"
      FROM "app_connection_resources"
      WHERE
        "connection_id" = ${googleConnection.id}
        AND "resource_type" = 'calendar'
        AND "enabled" = true
      LIMIT 1
    `;
    assert.ok(rememberResource);
    const rememberTurnId = `remember-turn-${suffix}`;
    const rememberInteractionId = `remember-interaction-${suffix}`;
    const rememberRequestId = `remember-request-${suffix}`;
    const rememberApprovalId = `remember-approval-${suffix}`;
    const rememberPreparedId = `remember-prepared-${suffix}`;
    const rememberToolName = "kestrel_one.google_calendar_create_event";
    const rememberExpiresAt = new Date(Date.now() + 60_000);
    const rememberToolIdentity = {
      version: "stable_tool_approval_identity_v1" as const,
      toolId: rememberToolName,
      descriptorContractRevision: `sha256:${"a".repeat(64)}`,
      approvalAuthorityRevision: `sha256:${"b".repeat(64)}`,
    };
    await appApprovals.recordAppOperationApprovalRequest({
      projectId,
      requestedExecutionId: runId,
      expiresAt: rememberExpiresAt,
      runtimeBinding: {
        version: RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
        approvalId: rememberApprovalId,
        preparedInvocationId: rememberPreparedId,
        threadId,
        actionKey: rememberToolName,
        payloadHash: `sha256:${"c".repeat(64)}`,
        stableAuthorityFingerprint: `sha256:${"d".repeat(64)}`,
        stableToolIdentity: rememberToolIdentity,
        requestingActor: {
          actorType: "end_user",
          actorId: userId,
          tenantId: organizationId,
        },
        toolClass: "external_side_effect",
        capabilities: ["network.call"],
        authorityKind: "hosted_app_policy",
        authorityRevision: rememberToolIdentity.approvalAuthorityRevision,
        requestedAt: now.toISOString(),
        expiresAt: rememberExpiresAt.toISOString(),
      },
      binding: {
        organizationId,
        environmentId,
        workspaceId,
        threadId,
        actorUserId: userId,
        agentId: "kestrel-one",
        appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
        capabilityKey: "calendar.events.create",
        connectionId: googleConnection.id,
        resourceId: rememberResource.id,
        resourceType: rememberResource.resourceType,
        operationKey: "events.create",
        runtimeApprovalId: rememberApprovalId,
        payload: {
          event: {
            summary: "Remembered approval proof",
            start: { dateTime: "2026-08-27T13:00:00.000Z" },
            end: { dateTime: "2026-08-27T14:00:00.000Z" },
          },
        },
      },
    });
    const rememberRequestEnvelope = {
      version: "runner_hosted_tool_approval_interaction_v4",
      requestId: rememberRequestId,
      kind: "approval",
      eventType: "user.approval",
      prompt: `Approve ${rememberToolName}?`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["decision"],
        properties: {
          decision: {
            type: "string",
            enum: ["decline", "approve_once", "remember_approval"],
          },
        },
      },
      approval: {
        preparedInvocationId: rememberPreparedId,
        toolName: rememberToolName,
        stableToolIdentity: rememberToolIdentity,
        requestingActor: {
          actorType: "end_user",
          actorId: userId,
          tenantId: organizationId,
        },
        requestedAt: now.toISOString(),
        expiresAt: rememberExpiresAt.toISOString(),
        presentation: {
          policy: {
            mode: "ask",
            reasonCode: "project_restriction",
            authorityKind: "hosted_app_policy",
            authorityRevision: rememberToolIdentity.approvalAuthorityRevision,
            rememberApprovalEligible: true,
          },
        },
      },
    };
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "thread_turns" (
          "id", "organization_id", "thread_id", "author_user_id",
          "approval_id", "approval_approved", "requested_environment_id",
          "idempotency_key", "sequence", "queue_ordinal", "status"
        ) VALUES (
          ${rememberTurnId}, ${organizationId}, ${threadId}, ${userId},
          ${rememberApprovalId}, true, ${environmentId},
          ${`remember-${suffix}`}, 99, 99,
          'waiting_for_input'
        )
      `;
      await transaction`
        INSERT INTO "thread_interactions" (
          "id", "request_id", "organization_id", "thread_id", "turn_id",
          "source", "kind", "event_type", "prompt", "status",
          "request_envelope", "runtime_approval_id", "source_runtime_run_id"
        ) VALUES (
          ${rememberInteractionId}, ${rememberRequestId}, ${organizationId},
          ${threadId}, ${rememberTurnId}, 'runtime', 'approval',
          'user.approval', ${rememberRequestEnvelope.prompt}, 'pending',
          ${transaction.json(rememberRequestEnvelope)}, ${rememberApprovalId},
          ${runId}
        )
      `;
      await transaction`
        INSERT INTO "thread_turn_queue_state" (
          "thread_id", "active_turn_id", "next_sequence", "state",
          "pause_reason", "version"
        ) VALUES (
          ${threadId}, ${rememberTurnId}, 100, 'paused',
          'interaction_required', 1
        )
        ON CONFLICT ("thread_id") DO UPDATE SET
          "active_turn_id" = EXCLUDED."active_turn_id",
          "next_sequence" = EXCLUDED."next_sequence",
          "state" = EXCLUDED."state",
          "pause_reason" = EXCLUDED."pause_reason",
          "version" = "thread_turn_queue_state"."version" + 1
      `;
      await transaction`
        UPDATE "app_operation_approvals"
        SET "interaction_id" = ${rememberInteractionId}
        WHERE
          "organization_id" = ${organizationId}
          AND "runtime_approval_id" = ${rememberApprovalId}
      `;
    });
    const projectAskPolicy = await runtimeApprovalPolicy.resolveRuntimeApprovalPolicies({
      threadId,
      organizationId,
      projectId,
      userId,
      canEditProject: false,
      interactions: [{
        id: rememberInteractionId,
        requestId: rememberRequestId,
        source: "runtime",
        kind: "approval",
        status: "pending",
        requestEnvelope: rememberRequestEnvelope,
      }],
    });
    assert.deepEqual({
      environmentApprovalMode:
        projectAskPolicy.get(rememberRequestId)?.environmentApprovalMode,
      projectApprovalMode:
        projectAskPolicy.get(rememberRequestId)?.projectApprovalMode,
      rememberApprovalEligible:
        projectAskPolicy.get(rememberRequestId)?.rememberApprovalEligible,
    }, {
      environmentApprovalMode: "auto",
      projectApprovalMode: "ask",
      rememberApprovalEligible: true,
    });
    const rememberedResolution = await turnStore.resolveDurableRuntimeInteraction({
      threadId,
      organizationId,
      userId,
      requestId: rememberRequestId,
      eventType: "user.approval",
      turnId: rememberTurnId,
      message: "Remember approval",
      decision: "remember_approval",
      messageId: `remember-message-${suffix}`,
      source: "web",
    });
    assert.equal(rememberedResolution.shouldDispatch, true);
    const [rememberedCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "remembered_tool_approvals"
      WHERE
        "organization_id" = ${organizationId}
        AND "thread_id" = ${threadId}
        AND "actor_user_id" = ${userId}
        AND "source_interaction_id" = ${rememberInteractionId}
    `;
    assert.equal(rememberedCount?.count, 1);
    const repeatedRemember = await turnStore.resolveDurableRuntimeInteraction({
      threadId,
      organizationId,
      userId,
      requestId: rememberRequestId,
      eventType: "user.approval",
      turnId: rememberTurnId,
      message: "Remember approval",
      decision: "remember_approval",
      messageId: `remember-message-replay-${suffix}`,
      source: "mobile",
    });
    assert.equal(repeatedRemember.shouldDispatch, false);
    await assert.rejects(
      turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: rememberRequestId,
        eventType: "user.approval",
        turnId: rememberTurnId,
        message: "Decline",
        decision: "decline",
        messageId: `remember-message-conflict-${suffix}`,
        source: "web",
      }),
      /conflicts with the recorded decision/u,
    );
    await sql`
      DELETE FROM "app_operation_approvals"
      WHERE
        "organization_id" = ${organizationId}
        AND "runtime_approval_id" = ${rememberApprovalId}
    `;
    await appService.saveEnvironmentAppCapabilityGrant({
      organizationId,
      environmentId,
      appKey: "built_in.workspace",
      capabilityKey: "executeCommand",
      grant: {
        enabled: true,
        approvalMode: "ask",
        loggingMode: "metadata_only",
        rateLimitMode: "strict",
      },
    });
    const createExecRememberInteraction = async (
      label: string,
      sequence: number,
      timing: {
        legacy?: boolean;
        requestedAt?: string;
        expiresAt?: string;
      } = {},
    ) => {
      const turnId = `exec-remember-${label}-turn-${suffix}`;
      const interactionId = `exec-remember-${label}-interaction-${suffix}`;
      const requestId = `exec-remember-${label}-request-${suffix}`;
      const toolIdentity = {
        version: "stable_tool_approval_identity_v1" as const,
        toolId: "exec_command",
        descriptorContractRevision: `sha256:${"7".repeat(64)}`,
        approvalAuthorityRevision: `sha256:${"8".repeat(64)}`,
      };
      const requestEnvelope = {
        version: timing.legacy
          ? "runner_hosted_tool_approval_interaction_v3"
          : "runner_hosted_tool_approval_interaction_v4",
        requestId,
        kind: "approval",
        eventType: "user.approval",
        prompt: "Approve exec_command?",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["decision"],
          properties: {
            decision: {
              type: "string",
              enum: ["decline", "approve_once", "remember_approval"],
            },
          },
        },
        approval: {
          preparedInvocationId: `exec-remember-${label}-prepared-${suffix}`,
          toolName: "exec_command",
          stableToolIdentity: toolIdentity,
          requestingActor: {
            actorType: "end_user",
            actorId: userId,
            tenantId: organizationId,
          },
          ...(timing.legacy
            ? {}
            : {
                requestedAt:
                  timing.requestedAt ??
                  new Date(Date.now() - 1_000).toISOString(),
                expiresAt:
                  timing.expiresAt ??
                  new Date(Date.now() + 60_000).toISOString(),
              }),
          presentation: {
            policy: {
              mode: "ask",
              reasonCode: "environment_policy",
              authorityKind: "hosted_app_policy",
              authorityRevision: toolIdentity.approvalAuthorityRevision,
              rememberApprovalEligible: true,
            },
          },
        },
      };
      await sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO "thread_turns" (
            "id", "organization_id", "thread_id", "author_user_id",
            "approval_id", "approval_approved", "requested_environment_id",
            "idempotency_key", "sequence", "queue_ordinal", "status"
          ) VALUES (
            ${turnId}, ${organizationId}, ${threadId}, ${userId},
            ${requestId}, true, ${environmentId},
            ${`exec-remember-${label}-${suffix}`}, ${sequence}, ${sequence},
            'waiting_for_input'
          )
        `;
        await transaction`
          INSERT INTO "thread_interactions" (
            "id", "request_id", "organization_id", "thread_id", "turn_id",
            "source", "kind", "event_type", "prompt", "status",
            "request_envelope", "runtime_approval_id", "source_runtime_run_id"
          ) VALUES (
            ${interactionId}, ${requestId}, ${organizationId}, ${threadId},
            ${turnId}, 'runtime', 'approval', 'user.approval',
            ${requestEnvelope.prompt}, 'pending',
            ${transaction.json(requestEnvelope)}, ${requestId}, ${runId}
          )
        `;
        await transaction`
          INSERT INTO "thread_turn_queue_state" (
            "thread_id", "active_turn_id", "next_sequence", "state",
            "pause_reason", "version"
          ) VALUES (
            ${threadId}, ${turnId}, ${sequence + 1}, 'paused',
            'interaction_required', 1
          )
          ON CONFLICT ("thread_id") DO UPDATE SET
            "active_turn_id" = EXCLUDED."active_turn_id",
            "next_sequence" = EXCLUDED."next_sequence",
            "state" = EXCLUDED."state",
            "pause_reason" = EXCLUDED."pause_reason",
            "version" = "thread_turn_queue_state"."version" + 1
        `;
      });
      return { interactionId, requestEnvelope, requestId, turnId };
    };
    const subjectExecRemember = await createExecRememberInteraction(
      "subject",
      189,
    );
    const builtInSubjectRestrictionId = `exec-subject-restriction-${suffix}`;
    const [insertedWorkspaceProvider] = await sql<Array<{ key: string }>>`
      INSERT INTO "tool_providers" (
        "key", "display_name", "description", "type", "auth_type", "metadata"
      ) VALUES (
        'built_in.workspace', 'Workspace', 'Workspace execution tools.',
        'built_in', 'system', ${sql.json({ category: "built_in" })}
      )
      ON CONFLICT ("key") DO NOTHING
      RETURNING "key"
    `;
    const [insertedWorkspaceCapability] = await sql<Array<{ key: string }>>`
      INSERT INTO "tool_capabilities" (
        "provider_key", "key", "runtime_name", "display_name", "description",
        "access_mode", "default_enabled", "default_approval_mode"
      ) VALUES (
        'built_in.workspace', 'executeCommand', 'exec_command',
        'Execute Command', 'Execute a workspace command.', 'write', true, 'ask'
      )
      ON CONFLICT ("provider_key", "key") DO NOTHING
      RETURNING "key"
    `;
    await sql`
      INSERT INTO "environment_capability_subject_restrictions" (
        "id", "organization_id", "environment_id", "subject_type",
        "subject_id", "provider_key", "capability_key", "resource_id",
        "enabled", "approval_mode"
      ) VALUES (
        ${builtInSubjectRestrictionId}, ${organizationId}, ${environmentId},
        'actor', ${userId}, 'built_in.workspace', 'executeCommand', NULL,
        true, 'ask'
      )
    `;
    const resolveExecSubjectPolicy = () =>
      runtimeApprovalPolicy.resolveRuntimeApprovalPolicies({
        threadId,
        organizationId,
        projectId,
        userId,
        canEditProject: false,
        interactions: [{
          id: subjectExecRemember.interactionId,
          requestId: subjectExecRemember.requestId,
          source: "runtime",
          kind: "approval",
          status: "pending",
          requestEnvelope: subjectExecRemember.requestEnvelope,
        }],
      });
    const subjectAskExecPolicy = await resolveExecSubjectPolicy();
    assert.deepEqual(
      {
        subjectApprovalMode:
          subjectAskExecPolicy.get(subjectExecRemember.requestId)
            ?.subjectApprovalMode,
        approvalResourceAvailable:
          subjectAskExecPolicy.get(subjectExecRemember.requestId)
            ?.approvalResourceAvailable,
        rememberApprovalEligible:
          subjectAskExecPolicy.get(subjectExecRemember.requestId)
            ?.rememberApprovalEligible,
      },
      {
        subjectApprovalMode: "ask",
        approvalResourceAvailable: undefined,
        rememberApprovalEligible: false,
      },
    );
    await sql`
      UPDATE "environment_capability_subject_restrictions"
      SET "approval_mode" = 'deny'
      WHERE "id" = ${builtInSubjectRestrictionId}
    `;
    const subjectBlockedExecPolicy = await resolveExecSubjectPolicy();
    assert.equal(
      subjectBlockedExecPolicy.get(subjectExecRemember.requestId)
        ?.subjectApprovalMode,
      "deny",
    );
    assert.equal(
      subjectBlockedExecPolicy.get(subjectExecRemember.requestId)
        ?.rememberApprovalEligible,
      false,
    );
    await sql`
      DELETE FROM "environment_capability_subject_restrictions"
      WHERE "id" = ${builtInSubjectRestrictionId}
    `;
    if (insertedWorkspaceCapability) {
      await sql`
        DELETE FROM "tool_capabilities"
        WHERE "provider_key" = 'built_in.workspace'
          AND "key" = ${insertedWorkspaceCapability.key}
      `;
    }
    if (insertedWorkspaceProvider) {
      await sql`
        DELETE FROM "tool_providers"
        WHERE "key" = ${insertedWorkspaceProvider.key}
      `;
    }
    const legacyExecApproveOnce = await createExecRememberInteraction(
      "legacy-approve-once",
      188,
      { legacy: true },
    );
    const legacyExecApproveOnceResolution =
      await turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: legacyExecApproveOnce.requestId,
        eventType: "user.approval",
        turnId: legacyExecApproveOnce.turnId,
        message: "Approve once",
        decision: "approve_once",
        messageId: `exec-legacy-approve-once-message-${suffix}`,
        source: "web",
      });
    assert.equal(legacyExecApproveOnceResolution.shouldDispatch, true);
    const legacyExecRemember = await createExecRememberInteraction(
      "legacy-remember",
      187,
      { legacy: true },
    );
    await assert.rejects(
      () => turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: legacyExecRemember.requestId,
        eventType: "user.approval",
        turnId: legacyExecRemember.turnId,
        message: "Remember approval",
        decision: "remember_approval",
        messageId: `exec-legacy-remember-message-${suffix}`,
        source: "mobile",
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "TURN_CONFLICT",
    );
    const [legacyExecRememberState] = await sql<
      Array<{
        status: string;
        failureCode: string | null;
        rememberedCount: number;
      }>
    >`
      SELECT
        interaction."status",
        interaction."response_failure_code" AS "failureCode",
        (SELECT count(*)::int FROM "remembered_tool_approvals"
          WHERE "source_interaction_id" = ${legacyExecRemember.interactionId})
          AS "rememberedCount"
      FROM "thread_interactions" interaction
      WHERE interaction."id" = ${legacyExecRemember.interactionId}
    `;
    assert.deepEqual(legacyExecRememberState, {
      status: "pending",
      failureCode: null,
      rememberedCount: 0,
    });
    const execRemember = await createExecRememberInteraction("eligible", 190);
    const execRememberResolution = await turnStore.resolveDurableRuntimeInteraction({
      threadId,
      organizationId,
      userId,
      requestId: execRemember.requestId,
      eventType: "user.approval",
      turnId: execRemember.turnId,
      message: "Remember approval",
      decision: "remember_approval",
      messageId: `exec-remember-message-${suffix}`,
      source: "web",
    });
    assert.equal(execRememberResolution.shouldDispatch, true);
    const [execRememberState] = await sql<
      Array<{ appApprovalCount: number; rememberedCount: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM "app_operation_approvals"
          WHERE "interaction_id" = ${execRemember.interactionId})
          AS "appApprovalCount",
        (SELECT count(*)::int FROM "remembered_tool_approvals"
          WHERE "source_interaction_id" = ${execRemember.interactionId})
          AS "rememberedCount"
    `;
    assert.deepEqual(execRememberState, { appApprovalCount: 0, rememberedCount: 1 });
    const expiredExecRemember = await createExecRememberInteraction(
      "expired",
      191,
      {
        requestedAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    );
    const expiredExecResolution =
      await turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: expiredExecRemember.requestId,
        eventType: "user.approval",
        turnId: expiredExecRemember.turnId,
        message: "Remember approval",
        decision: "remember_approval",
        messageId: `exec-remember-expired-message-${suffix}`,
        source: "web",
      });
    assert.equal(expiredExecResolution.shouldDispatch, false);
    const [expiredExecState] = await sql<
      Array<{
        appApprovalCount: number;
        failureCode: string | null;
        rememberedCount: number;
        turnStatus: string;
      }>
    >`
      SELECT
        interaction."response_failure_code" AS "failureCode",
        turn."status" AS "turnStatus",
        (SELECT count(*)::int FROM "app_operation_approvals"
          WHERE "interaction_id" = ${expiredExecRemember.interactionId})
          AS "appApprovalCount",
        (SELECT count(*)::int FROM "remembered_tool_approvals"
          WHERE "source_interaction_id" = ${expiredExecRemember.interactionId})
          AS "rememberedCount"
      FROM "thread_interactions" interaction
      JOIN "thread_turns" turn ON turn."id" = interaction."turn_id"
      WHERE interaction."id" = ${expiredExecRemember.interactionId}
    `;
    assert.deepEqual(expiredExecState, {
      appApprovalCount: 0,
      failureCode: "EXTERNAL_APPROVAL_EXPIRED",
      rememberedCount: 0,
      turnStatus: "failed",
    });
    const staleExecRemember = await createExecRememberInteraction("stale", 192);
    await appService.saveEnvironmentAppCapabilityGrant({
      organizationId,
      environmentId,
      appKey: "built_in.workspace",
      capabilityKey: "executeCommand",
      grant: {
        enabled: true,
        approvalMode: "deny",
        loggingMode: "metadata_only",
        rateLimitMode: "strict",
      },
    });
    const staleExecResolution = await turnStore.resolveDurableRuntimeInteraction({
      threadId,
      organizationId,
      userId,
      requestId: staleExecRemember.requestId,
      eventType: "user.approval",
      turnId: staleExecRemember.turnId,
      message: "Remember approval",
      decision: "remember_approval",
      messageId: `exec-remember-stale-message-${suffix}`,
      source: "mobile",
    });
    assert.equal(staleExecResolution.shouldDispatch, false);
    const [staleExecState] = await sql<
      Array<{ failureCode: string | null; rememberedCount: number }>
    >`
      SELECT
        interaction."response_failure_code" AS "failureCode",
        (SELECT count(*)::int FROM "remembered_tool_approvals" remembered
          WHERE remembered."source_interaction_id" = interaction."id")
          AS "rememberedCount"
      FROM "thread_interactions" interaction
      WHERE interaction."id" = ${staleExecRemember.interactionId}
    `;
    assert.deepEqual(staleExecState, {
      failureCode: "EXTERNAL_APPROVAL_POLICY_CHANGED",
      rememberedCount: 0,
    });
    const createAdditionalRememberInteraction = async (input: {
      label: string;
      sequence: number;
      legacy?: boolean;
    }) => {
      const approvalId = `remember-${input.label}-approval-${suffix}`;
      const preparedInvocationId = `remember-${input.label}-prepared-${suffix}`;
      const interactionId = `remember-${input.label}-interaction-${suffix}`;
      const requestId = `remember-${input.label}-request-${suffix}`;
      const turnId = `remember-${input.label}-turn-${suffix}`;
      const expiresAt = new Date(Date.now() + 60_000);
      await appApprovals.recordAppOperationApprovalRequest({
        projectId,
        requestedExecutionId: runId,
        expiresAt,
        runtimeBinding: {
          version: RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
          approvalId,
          preparedInvocationId,
          threadId,
          actionKey: rememberToolName,
          payloadHash: `sha256:${"e".repeat(64)}`,
          stableAuthorityFingerprint: `sha256:${"f".repeat(64)}`,
          stableToolIdentity: rememberToolIdentity,
          requestingActor: {
            actorType: "end_user",
            actorId: userId,
            tenantId: organizationId,
          },
          toolClass: "external_side_effect",
          capabilities: ["network.call"],
          authorityKind: "hosted_app_policy",
          authorityRevision: rememberToolIdentity.approvalAuthorityRevision,
          requestedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        binding: {
          organizationId,
          environmentId,
          workspaceId,
          threadId,
          actorUserId: userId,
          agentId: "kestrel-one",
          appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
          capabilityKey: "calendar.events.create",
          connectionId: googleConnection.id,
          resourceId: rememberResource.id,
          resourceType: rememberResource.resourceType,
          operationKey: "events.create",
          runtimeApprovalId: approvalId,
          payload: {
            event: {
              summary: `Remembered approval ${input.label}`,
              start: { dateTime: "2026-08-27T15:00:00.000Z" },
              end: { dateTime: "2026-08-27T16:00:00.000Z" },
            },
          },
        },
      });
      const {
        requestedAt: _requestedAt,
        expiresAt: _expiresAt,
        ...legacyApproval
      } = rememberRequestEnvelope.approval;
      const requestEnvelope = input.legacy
        ? {
            ...rememberRequestEnvelope,
            version: "runner_hosted_tool_approval_interaction_v3",
            requestId,
            approval: {
              ...legacyApproval,
              preparedInvocationId,
            },
          }
        : {
            ...rememberRequestEnvelope,
            requestId,
            approval: {
              ...rememberRequestEnvelope.approval,
              preparedInvocationId,
              expiresAt: expiresAt.toISOString(),
            },
          };
      await sql.begin(async (transaction) => {
        await transaction`
            INSERT INTO "thread_turns" (
              "id", "organization_id", "thread_id", "author_user_id",
              "approval_id", "approval_approved", "requested_environment_id",
              "idempotency_key", "sequence", "queue_ordinal", "status"
            ) VALUES (
              ${turnId}, ${organizationId}, ${threadId}, ${userId},
              ${approvalId}, true, ${environmentId},
              ${`remember-${input.label}-${suffix}`}, ${input.sequence},
              ${input.sequence}, 'waiting_for_input'
            )
          `;
        await transaction`
            INSERT INTO "thread_interactions" (
              "id", "request_id", "organization_id", "thread_id", "turn_id",
              "source", "kind", "event_type", "prompt", "status",
              "request_envelope", "runtime_approval_id", "source_runtime_run_id"
            ) VALUES (
              ${interactionId}, ${requestId}, ${organizationId}, ${threadId},
              ${turnId}, 'runtime', 'approval', 'user.approval',
              ${requestEnvelope.prompt}, 'pending',
              ${transaction.json(requestEnvelope)}, ${approvalId}, ${runId}
            )
          `;
        await transaction`
            INSERT INTO "thread_turn_queue_state" (
              "thread_id", "active_turn_id", "next_sequence", "state",
              "pause_reason", "version"
            ) VALUES (
              ${threadId}, ${turnId}, ${input.sequence + 1}, 'paused',
              'interaction_required', 1
            )
            ON CONFLICT ("thread_id") DO UPDATE SET
              "active_turn_id" = EXCLUDED."active_turn_id",
              "next_sequence" = EXCLUDED."next_sequence",
              "state" = EXCLUDED."state",
              "pause_reason" = EXCLUDED."pause_reason",
              "version" = "thread_turn_queue_state"."version" + 1
          `;
        await transaction`
            UPDATE "app_operation_approvals"
            SET "interaction_id" = ${interactionId}
            WHERE
              "organization_id" = ${organizationId}
              AND "runtime_approval_id" = ${approvalId}
          `;
      });
      return { approvalId, interactionId, requestId, turnId };
    };

    const mixedClient = await createAdditionalRememberInteraction({
      label: "mixed-client",
      sequence: 100,
      legacy: true,
    });
    const mixedClientResolution =
      await turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: mixedClient.requestId,
        eventType: "user.approval",
        turnId: mixedClient.turnId,
        message: "Approve",
        approved: true,
        messageId: `remember-mixed-client-message-${suffix}`,
        source: "web",
      });
    assert.equal(mixedClientResolution.shouldDispatch, true);
    const [mixedClientState] = await sql<
      Array<{
        approved: boolean | null;
        decision: string | null;
        rememberedCount: number;
      }>
    >`
        SELECT
          (interaction."response_envelope"->>'approved')::boolean AS "approved",
          interaction."response_envelope"->>'decision' AS "decision",
          (SELECT count(*)::int FROM "remembered_tool_approvals" remembered
            WHERE remembered."source_interaction_id" = interaction."id")
            AS "rememberedCount"
        FROM "thread_interactions" interaction
        WHERE interaction."id" = ${mixedClient.interactionId}
      `;
    assert.deepEqual(mixedClientState, {
      approved: null,
      decision: "approve_once",
      rememberedCount: 0,
    });

    const policyChanged = await createAdditionalRememberInteraction({
      label: "policy-changed",
      sequence: 101,
    });
    await projectAppService.saveProjectAppCapabilityPolicy({
      organizationId,
      projectId,
      appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
      capabilityKey: "calendar.events.create",
      actorUserId: userId,
      enabled: false,
      approvalMode: "deny",
    });
    const policyChangedResolution =
      await turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: policyChanged.requestId,
        eventType: "user.approval",
        turnId: policyChanged.turnId,
        message: "Remember approval",
        decision: "remember_approval",
        messageId: `remember-policy-changed-message-${suffix}`,
        source: "web",
      });
    assert.equal(policyChangedResolution.shouldDispatch, false);
    const [policyChangedState] = await sql<
      Array<{
        availabilityStatus: string;
        effectStatus: string | null;
        failureCode: string | null;
        interactionStatus: string;
        turnStatus: string;
        queueState: string;
        queuePauseReason: string | null;
        activeTurnId: string | null;
        rememberedCount: number;
      }>
    >`
        SELECT
          approval."availability_status" AS "availabilityStatus",
          interaction."effect_status" AS "effectStatus",
          interaction."response_failure_code" AS "failureCode",
          interaction."status" AS "interactionStatus",
          turn."status" AS "turnStatus",
          queue."state" AS "queueState",
          queue."pause_reason" AS "queuePauseReason",
          queue."active_turn_id" AS "activeTurnId",
          (SELECT count(*)::int FROM "remembered_tool_approvals" remembered
            WHERE remembered."source_interaction_id" = interaction."id")
            AS "rememberedCount"
        FROM "thread_interactions" interaction
        JOIN "app_operation_approvals" approval
          ON approval."interaction_id" = interaction."id"
        JOIN "thread_turns" turn ON turn."id" = interaction."turn_id"
        JOIN "thread_turn_queue_state" queue
          ON queue."thread_id" = interaction."thread_id"
        WHERE interaction."id" = ${policyChanged.interactionId}
      `;
    assert.deepEqual(policyChangedState, {
      availabilityStatus: "expired",
      effectStatus: "not_started",
      failureCode: "EXTERNAL_APPROVAL_POLICY_CHANGED",
      interactionStatus: "failed",
      turnStatus: "failed",
      queueState: "paused",
      queuePauseReason: "turn_failed",
      activeTurnId: null,
      rememberedCount: 0,
    });
    const repeatedPolicyChanged =
      await turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: policyChanged.requestId,
        eventType: "user.approval",
        turnId: policyChanged.turnId,
        message: "Remember approval",
        decision: "remember_approval",
        messageId: `remember-policy-changed-replay-${suffix}`,
        source: "mobile",
      });
    assert.equal(repeatedPolicyChanged.shouldDispatch, false);
    await assert.rejects(
      turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: policyChanged.requestId,
        eventType: "user.approval",
        turnId: policyChanged.turnId,
        message: "Decline",
        decision: "decline",
        messageId: `remember-policy-changed-conflict-${suffix}`,
        source: "web",
      }),
      /conflicts with the recorded decision/u,
    );
    await projectAppService.saveProjectAppCapabilityPolicy({
      organizationId,
      projectId,
      appKey: googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY,
      capabilityKey: "calendar.events.create",
      actorUserId: userId,
      enabled: true,
      approvalMode: "ask",
    });
    const subjectRestricted = await createAdditionalRememberInteraction({
      label: "subject-restricted",
      sequence: 102,
    });
    const subjectRestrictionId = `remember-subject-restriction-${suffix}`;
    await sql`
      INSERT INTO "environment_capability_subject_restrictions" (
        "id", "organization_id", "environment_id", "subject_type",
        "subject_id", "provider_key", "capability_key", "resource_id",
        "enabled", "approval_mode"
      ) VALUES (
        ${subjectRestrictionId}, ${organizationId}, ${environmentId}, 'actor',
        ${userId}, ${googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY},
        'calendar.events.create', NULL, true, 'ask'
      )
    `;
    const subjectRestrictedPolicy = await runtimeApprovalPolicy.resolveRuntimeApprovalPolicies({
      threadId,
      organizationId,
      projectId,
      userId,
      canEditProject: false,
      interactions: [{
        id: subjectRestricted.interactionId,
        requestId: subjectRestricted.requestId,
        source: "runtime",
        kind: "approval",
        status: "pending",
        requestEnvelope: rememberRequestEnvelope,
      }],
    });
    assert.deepEqual(
      {
        subjectApprovalMode:
          subjectRestrictedPolicy.get(subjectRestricted.requestId)
            ?.subjectApprovalMode,
        approvalResourceAvailable:
          subjectRestrictedPolicy.get(subjectRestricted.requestId)
            ?.approvalResourceAvailable,
        rememberApprovalEligible:
          subjectRestrictedPolicy.get(subjectRestricted.requestId)
            ?.rememberApprovalEligible,
      },
      {
        subjectApprovalMode: "ask",
        approvalResourceAvailable: true,
        rememberApprovalEligible: false,
      },
    );
    const subjectRestrictedResolution =
      await turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: subjectRestricted.requestId,
        eventType: "user.approval",
        turnId: subjectRestricted.turnId,
        message: "Remember approval",
        decision: "remember_approval",
        messageId: `remember-subject-restricted-message-${suffix}`,
        source: "web",
      });
    assert.equal(subjectRestrictedResolution.shouldDispatch, false);
    const [subjectRestrictedState] = await sql<
      Array<{
        failureCode: string | null;
        rememberedCount: number;
        turnStatus: string;
      }>
    >`
      SELECT
        interaction."response_failure_code" AS "failureCode",
        turn."status" AS "turnStatus",
        (SELECT count(*)::int FROM "remembered_tool_approvals" remembered
          WHERE remembered."source_interaction_id" = interaction."id")
          AS "rememberedCount"
      FROM "thread_interactions" interaction
      JOIN "thread_turns" turn ON turn."id" = interaction."turn_id"
      WHERE interaction."id" = ${subjectRestricted.interactionId}
    `;
    assert.deepEqual(subjectRestrictedState, {
      failureCode: "EXTERNAL_APPROVAL_POLICY_CHANGED",
      rememberedCount: 0,
      turnStatus: "failed",
    });
    await sql`
      DELETE FROM "environment_capability_subject_restrictions"
      WHERE "id" = ${subjectRestrictionId}
    `;

    const expiredApproveOnce = await createAdditionalRememberInteraction({
      label: "expired-approve-once",
      sequence: 103,
    });
    await sql`
      UPDATE "app_operation_approvals"
      SET "expires_at" = ${new Date(Date.now() - 1000)}
      WHERE "organization_id" = ${organizationId}
        AND "runtime_approval_id" = ${expiredApproveOnce.approvalId}
    `;
    const expiredApproveOnceResolution =
      await turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: expiredApproveOnce.requestId,
        eventType: "user.approval",
        turnId: expiredApproveOnce.turnId,
        message: "Approve once",
        decision: "approve_once",
        messageId: `remember-expired-approve-once-message-${suffix}`,
        source: "mobile",
      });
    assert.equal(expiredApproveOnceResolution.shouldDispatch, false);
    const [expiredApproveOnceState] = await sql<
      Array<{ failureCode: string | null; interactionStatus: string; turnStatus: string }>
    >`
      SELECT
        interaction."response_failure_code" AS "failureCode",
        interaction."status" AS "interactionStatus",
        turn."status" AS "turnStatus"
      FROM "thread_interactions" interaction
      JOIN "thread_turns" turn ON turn."id" = interaction."turn_id"
      WHERE interaction."id" = ${expiredApproveOnce.interactionId}
    `;
    assert.deepEqual(expiredApproveOnceState, {
      failureCode: "EXTERNAL_APPROVAL_EXPIRED",
      interactionStatus: "failed",
      turnStatus: "failed",
    });

    const closedResourceApproveOnce = await createAdditionalRememberInteraction({
      label: "closed-resource-approve-once",
      sequence: 104,
    });
    await sql`
      UPDATE "app_connection_resources"
      SET "enabled" = false
      WHERE "id" = ${rememberResource.id}
    `;
    const closedResourcePolicy = await runtimeApprovalPolicy.resolveRuntimeApprovalPolicies({
      threadId,
      organizationId,
      projectId,
      userId,
      canEditProject: false,
      interactions: [{
        id: closedResourceApproveOnce.interactionId,
        requestId: closedResourceApproveOnce.requestId,
        source: "runtime",
        kind: "approval",
        status: "pending",
        requestEnvelope: rememberRequestEnvelope,
      }],
    });
    assert.equal(
      closedResourcePolicy.get(closedResourceApproveOnce.requestId)
        ?.approvalResourceAvailable,
      false,
    );
    const closedResourceResolution =
      await turnStore.resolveDurableRuntimeInteraction({
        threadId,
        organizationId,
        userId,
        requestId: closedResourceApproveOnce.requestId,
        eventType: "user.approval",
        turnId: closedResourceApproveOnce.turnId,
        message: "Approve once",
        decision: "approve_once",
        messageId: `remember-closed-resource-message-${suffix}`,
        source: "web",
      });
    assert.equal(closedResourceResolution.shouldDispatch, false);
    await sql`
      UPDATE "app_connection_resources"
      SET "enabled" = true
      WHERE "id" = ${rememberResource.id}
    `;
    await sql`
      DELETE FROM "app_operation_approvals"
      WHERE
        "organization_id" = ${organizationId}
        AND "runtime_approval_id" IN (
          ${mixedClient.approvalId}, ${policyChanged.approvalId},
          ${subjectRestricted.approvalId}, ${expiredApproveOnce.approvalId},
          ${closedResourceApproveOnce.approvalId}
        )
    `;
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
    await sql`
      INSERT INTO "app_connections" (
        "id", "organization_id", "app_key", "owner_type", "user_id",
        "auth_account_id", "name", "status", "external_account_id",
        "external_account_label", "scopes", "created_at", "updated_at"
      ) VALUES (
        ${isolatedGoogleConnectionId}, ${isolatedOrganizationId},
        ${googleContract.GOOGLE_WORKSPACE_PROVIDER_KEY}, 'personal', ${userId},
        ${googleAuthAccountId}, ${`${userId}@example.test`}, 'connected',
        ${googleProviderAccountId}, ${`${userId}@example.test`},
        ${sql.json([...googleContract.GOOGLE_CALENDAR_SCOPES])}, ${now}, ${now}
      )
    `;
    await googleOauth.disconnectGoogleCalendarUserConnection({
      organizationId,
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
    const [googleDisconnectState] = await sql<
      Array<{
        accountCount: string;
        capabilityCount: string;
        connectionStatus: string;
        isolatedStatus: string;
        projectConnectionCount: string;
        resourceCount: string;
      }>
    >`
      SELECT
        (SELECT count(*)::text FROM "account"
          WHERE "id" = ${googleAuthAccountId}) AS "accountCount",
        (SELECT count(*)::text FROM "project_app_user_capabilities"
          WHERE "connection_id" = ${googleConnection.id}) AS "capabilityCount",
        (SELECT "status" FROM "app_connections"
          WHERE "id" = ${googleConnection.id}) AS "connectionStatus",
        (SELECT "status" FROM "app_connections"
          WHERE "id" = ${isolatedGoogleConnectionId}) AS "isolatedStatus",
        (SELECT count(*)::text FROM "project_app_connections"
          WHERE "connection_id" = ${googleConnection.id}) AS "projectConnectionCount",
        (SELECT count(*)::text FROM "app_connection_resources"
          WHERE "connection_id" = ${googleConnection.id}) AS "resourceCount"
    `;
    assert.deepEqual(googleDisconnectState, {
      accountCount: "1",
      capabilityCount: "0",
      connectionStatus: "disconnected",
      isolatedStatus: "connected",
      projectConnectionCount: "0",
      resourceCount: "0",
    });

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
    await microsoftOauth.disconnectMicrosoft365Connection({
      organizationId,
      userId,
    });
    const [microsoftDisconnectState] = await sql<
      Array<{
        accountCount: string;
        attachmentCount: string;
        status: string;
      }>
    >`
      SELECT
        (SELECT count(*)::text FROM "account"
          WHERE "id" = ${microsoftAuthAccountId}) AS "accountCount",
        (SELECT count(*)::text FROM "project_app_connections"
          WHERE "connection_id" = ${microsoftConnection.id}) AS "attachmentCount",
        (SELECT "status" FROM "app_connections"
          WHERE "id" = ${microsoftConnection.id}) AS "status"
    `;
    assert.deepEqual(microsoftDisconnectState, {
      accountCount: "1",
      attachmentCount: "0",
      status: "disconnected",
    });

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

    const ociDigest = `sha256:${"a".repeat(64)}`;
    const defaultDeniedOci = await mcpControl.installEnvironmentMcpServer({
      organizationId,
      environmentId,
      actorUserId: userId,
      server: {
        name: "Offline OCI",
        slug: "offline-oci",
        sourceType: "oci",
        transport: "stdio",
        imageReference: `ghcr.io/kestrel/offline@${ociDigest}`,
        digest: ociDigest,
        auth: { mode: "none" },
        launchArguments: [],
        egressPolicy: { version: 1, mode: "none" },
        resources: {
          cpuMillicores: 500,
          memoryMib: 512,
          pidsLimit: 128,
        },
      },
    });
    assert.equal(defaultDeniedOci.networkAccess, "none");
    assert.deepEqual(defaultDeniedOci.ociEgressPolicy, {
      mode: "none",
      version: 1,
    });
    assert.match(defaultDeniedOci.ociEgressPolicyDigest ?? "", /^sha256:/u);
    await assert.rejects(
      mcpControl.installEnvironmentMcpServer({
        organizationId,
        environmentId,
        actorUserId: userId,
        appKey: "atlassian",
        server: {
          name: "Untrusted Managed OCI",
          slug: "untrusted-managed-oci",
          sourceType: "oci",
          transport: "stdio",
          imageReference: `ghcr.io/kestrel/managed@${ociDigest}`,
          digest: ociDigest,
          auth: { mode: "none" },
          launchArguments: [],
          egressPolicy: { version: 1, mode: "none" },
          resources: {
            cpuMillicores: 500,
            memoryMib: 512,
            pidsLimit: 128,
          },
        },
      }),
      /trusted digest-bound manifest/u,
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
        networkAccess: "full",
        resources: {
          cpuMillicores: 500,
          memoryMib: 512,
          pidsLimit: 128,
        },
      },
    });
    await assert.rejects(
      sql`
        UPDATE "mcp_servers"
        SET "network_access" = 'none'
        WHERE "id" = ${customServer.id}
      `,
      /mcp_servers_remote_network_access_check|violates check constraint/u,
    );
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
    const resolvedMcpPolicy = await mcpGrant.resolveHostedMcpRunPolicy({
      organizationId,
      environmentId,
      projectId,
      gatewayUrl: "https://mcp-gateway.example.test",
    });
    assert.ok(resolvedMcpPolicy);
    const mcpContext = await mcpGrant.issueHostedMcpRunContext({
      runExecutionId: runId,
      threadId,
      executionProfileId: "profile-1",
      executionProfileFingerprint: "profile-fingerprint-1",
      resolvedPolicy: resolvedMcpPolicy,
    });
    assert.ok(mcpContext?.grantId);
    const [mcpRunGrant] = await sql<
      Array<{
        effectiveCapabilities: string[];
        effectivePolicy: Array<{
          capabilityId: string;
          approvalMode: string;
        }>;
        executionProfileId: string;
        executionProfileFingerprint: string;
        ociEgressBindings: unknown[];
      }>
    >`
      SELECT
        "effective_capabilities" AS "effectiveCapabilities",
        "effective_policy" AS "effectivePolicy",
        "execution_profile_id" AS "executionProfileId",
        "execution_profile_fingerprint" AS "executionProfileFingerprint",
        "oci_egress_bindings" AS "ociEgressBindings"
      FROM "mcp_run_grants"
      WHERE "id" = ${mcpContext?.grantId ?? ""}
    `;
    assert.deepEqual(mcpRunGrant, {
      effectiveCapabilities: [mcpCapabilityId],
      effectivePolicy: [{ capabilityId: mcpCapabilityId, approvalMode: "ask" }],
      executionProfileId: "profile-1",
      executionProfileFingerprint: "profile-fingerprint-1",
      ociEgressBindings: [],
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
    let githubRepositories = [
      {
        id: 4242,
        node_id: "repository-node-4242",
        full_name: "kestrel/apps-proof",
        default_branch: "main" as string | null,
        private: true,
        html_url: "https://github.com/kestrel/apps-proof",
        permissions: { pull: true, push: true, admin: false },
      },
    ];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/graphql")
        ? {
            data: {
              nodes: githubRepositories.map((repository) => ({
                id: repository.node_id,
                isEmpty: repository.default_branch === null,
              })),
            },
          }
        : url.includes("/user/repos")
          ? githubRepositories
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
    const [initialRepository] = await sql<Array<{ id: string }>>`
      SELECT "id"
      FROM "app_connection_resources"
      WHERE "connection_id" = ${githubSync.connection.id}
        AND "external_id" = 'repository-id:4242'
    `;
    assert.ok(initialRepository);
    githubRepositories = [
      {
        ...githubRepositories[0]!,
        full_name: "kestrel/apps-proof-renamed",
        html_url: "https://github.com/kestrel/apps-proof-renamed",
      },
      {
        id: 9898,
        node_id: "repository-node-9898",
        full_name: "kestrel/new-private-empty",
        default_branch: null,
        private: true,
        html_url: "https://github.com/kestrel/new-private-empty",
        permissions: { pull: true, push: true, admin: true },
      },
    ];
    await githubOauth.syncGithubUserConnection({
      organizationId,
      userId,
      authAccountId: githubAuthAccountId,
      providerAccountId: githubProviderAccountId,
      accessToken: "github-test-token",
      scopes: ["repo"],
    });
    const refreshedRepositories = await sql<
      Array<{
        id: string;
        externalId: string;
        label: string;
        enabled: boolean;
        repositoryId: string;
        defaultBranch: string | null;
        isEmpty: boolean;
        isPrivate: boolean;
      }>
    >`
      SELECT "id",
             "external_id" AS "externalId",
             "label",
             "enabled",
             "metadata"->>'repositoryId' AS "repositoryId",
             "metadata"->>'defaultBranch' AS "defaultBranch",
             ("metadata"->>'isEmpty')::boolean AS "isEmpty",
             ("metadata"->>'private')::boolean AS "isPrivate"
      FROM "app_connection_resources"
      WHERE "connection_id" = ${githubSync.connection.id}
      ORDER BY "external_id"
    `;
    assert.deepEqual([...refreshedRepositories], [
      {
        id: initialRepository.id,
        externalId: "repository-id:4242",
        label: "kestrel/apps-proof-renamed",
        enabled: true,
        repositoryId: "4242",
        defaultBranch: "main",
        isEmpty: false,
        isPrivate: true,
      },
      {
        id: refreshedRepositories[1]?.id,
        externalId: "repository-id:9898",
        label: "kestrel/new-private-empty",
        enabled: true,
        repositoryId: "9898",
        defaultBranch: null,
        isEmpty: true,
        isPrivate: true,
      },
    ]);
    githubRepositories = [githubRepositories[1]!];
    await githubOauth.syncGithubUserConnection({
      organizationId,
      userId,
      authAccountId: githubAuthAccountId,
      providerAccountId: githubProviderAccountId,
      accessToken: "github-test-token",
      scopes: ["repo"],
    });
    const [revokedRepository] = await sql<Array<{ enabled: boolean }>>`
      SELECT "enabled"
      FROM "app_connection_resources"
      WHERE "id" = ${initialRepository.id}
    `;
    assert.deepEqual(revokedRepository, { enabled: false });
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
    const [githubDisconnected] = await sql<
      Array<{
        accountCount: string;
        resourceCount: string;
        status: string;
      }>
    >`
      SELECT
        (SELECT count(*)::text FROM "account"
          WHERE "id" = ${githubAuthAccountId}) AS "accountCount",
        (SELECT count(*)::text FROM "app_connection_resources"
          WHERE "connection_id" = ${githubSync.connection.id}) AS "resourceCount",
        (SELECT "status" FROM "app_connections"
          WHERE "id" = ${githubSync.connection.id}) AS "status"
    `;
    assert.deepEqual(githubDisconnected, {
      accountCount: "1",
      resourceCount: "0",
      status: "disconnected",
    });

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
