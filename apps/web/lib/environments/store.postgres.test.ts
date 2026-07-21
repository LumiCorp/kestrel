import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import postgres from "postgres";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

contractTest(
  "web.postgres", "hosted Environment bindings preserve Thread identity and reject cross-organization resolution",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");
    process.env.KESTREL_ENVIRONMENTS_ENABLED = "true";
    process.env.CRON_SECRET = "cron-secret";

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY = publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    process.env.FLY_API_TOKEN = "FlyV1 test";
    process.env.KESTREL_FLY_ORGANIZATION_SLUG = "test-org";
    process.env.KESTREL_ENVIRONMENT_ROUTER_IMAGE = `registry.fly.io/kestrel-test@sha256:${"a".repeat(64)}`;
    process.env.KESTREL_WORKSPACE_RUNTIME_IMAGE = `registry.fly.io/kestrel-test@sha256:${"b".repeat(64)}`;
    process.env.KESTREL_WORKSPACE_BACKUP_KEY =
      randomBytes(32).toString("base64");
    process.env.KESTREL_WORKSPACE_BACKUP_KEY_ID = "test-backup-v1";
    process.env.KESTREL_ONE_APP_URL = "https://kestrel.example";
    process.env.KESTREL_ONE_CREDENTIAL_BROKER_TOKEN = "broker-secret";
    process.env.KESTREL_ONE_TOOL_TOKEN = "tool-secret";
    process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
    process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
      "test-key": randomBytes(32).toString("base64"),
    });
    Reflect.deleteProperty(process.env, "KESTREL_RUNNER_SERVICE_URL");
    Reflect.deleteProperty(process.env, "KESTREL_RUNNER_SERVICE_TOKEN");

    const [
      { resetDbRuntimeForTests },
      environmentStore,
      executionRoute,
      auth,
      githubPolicy,
      { databaseEnvironmentProvisioningRepository },
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./store"),
      import("./execution-route"),
      import("@lumi/kestrel-environment-auth"),
      import("@/lib/integrations/github-policy"),
      import("./provisioner"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    context.after(async () => {
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    const suffix = crypto.randomUUID();
    const organizationA = `org-a-${suffix}`;
    const organizationB = `org-b-${suffix}`;
    const userA = `user-a-${suffix}`;
    const userB = `user-b-${suffix}`;
    const memberA = `member-a-${suffix}`;
    const projectId = `project-${suffix}`;
    const projectThreadId = `thread-project-${suffix}`;
    const scratchThreadId = `thread-scratch-${suffix}`;
    const configuredScratchThreadId = `thread-configured-scratch-${suffix}`;
    const revisionId = `revision-${suffix}`;
    const repositoryResourceId = crypto.randomUUID();
    const githubAccountId = `github-account-${suffix}`;
    const githubConnectionId = crypto.randomUUID();
    const actorRestrictionId = crypto.randomUUID();
    const agentRestrictionId = crypto.randomUUID();
    const now = new Date();

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES
          (${userA}, 'Environment User A', ${`${userA}@example.test`}, true, ${now}, ${now}),
          (${userB}, 'Environment User B', ${`${userB}@example.test`}, true, ${now}, ${now})
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES
          (${organizationA}, 'Environment Org A', ${`environment-org-a-${suffix}`}, ${now}),
          (${organizationB}, 'Environment Org B', ${`environment-org-b-${suffix}`}, ${now})
      `;
      await transaction`
        INSERT INTO "member" (
          "id", "organizationId", "userId", "role", "createdAt"
        ) VALUES (${memberA}, ${organizationA}, ${userA}, 'owner', ${now})
      `;
    });

    const createdEnvironment =
      await environmentStore.createOrganizationEnvironment({
        organizationId: organizationA,
        userId: userA,
        environment: {
          name: "Primary Environment",
          region: "iad",
          isDefault: true,
        },
      });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "organization_feature_flags" (
          "organization_id", "key", "enabled", "updated_by_user_id"
        ) VALUES (${organizationA}, 'hosted_environments', false, ${userA})
      `;
      await transaction`
        INSERT INTO "projects" (
          "id", "organization_id", "environment_id", "created_by_user_id", "name"
        ) VALUES (
          ${projectId}, ${organizationA}, ${createdEnvironment.environment.id},
          ${userA}, 'Environment Project'
        )
      `;
      await transaction`
        INSERT INTO "project_members" (
          "project_id", "organization_member_id", "role"
        ) VALUES (${projectId}, ${memberA}, 'owner')
      `;
      await transaction`
        INSERT INTO "project_context_revisions" (
          "id", "project_id", "revision", "project_name", "instructions",
          "created_by_user_id"
        ) VALUES (
          ${revisionId}, ${projectId}, 1, 'Environment Project',
          'Keep the existing Thread identity.', ${userA}
        )
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id", "project_id"
        ) VALUES
          (
            ${projectThreadId}, 'Project Environment Thread', ${userA},
            ${organizationA}, ${projectId}
          ),
          (
            ${scratchThreadId}, 'Scratch Environment Thread', ${userA},
            ${organizationA}, NULL
          ),
          (
            ${configuredScratchThreadId}, 'Configured Scratch Thread', ${userA},
            ${organizationA}, NULL
          )
      `;
    });

    const projectBinding =
      await environmentStore.resolveOrCreateThreadExecutionBinding({
        organizationId: organizationA,
        threadId: projectThreadId,
        userId: userA,
      });
    assert.equal(projectBinding.created, true);
    assert.equal(projectBinding.binding.threadId, projectThreadId);
    assert.equal(projectBinding.workspace.projectId, projectId);
    assert.equal(projectBinding.workspace.kind, "project");

    const repeatedProjectBinding =
      await environmentStore.resolveOrCreateThreadExecutionBinding({
        organizationId: organizationA,
        threadId: projectThreadId,
        userId: userA,
      });
    assert.equal(repeatedProjectBinding.created, false);
    assert.equal(
      repeatedProjectBinding.workspace.id,
      projectBinding.workspace.id
    );

    const scratchBinding =
      await environmentStore.resolveOrCreateThreadExecutionBinding({
        organizationId: organizationA,
        threadId: scratchThreadId,
        userId: userA,
      });
    assert.equal(scratchBinding.created, true);
    assert.equal(scratchBinding.binding.threadId, scratchThreadId);
    assert.equal(scratchBinding.workspace.standaloneThreadId, scratchThreadId);
    assert.equal(scratchBinding.workspace.kind, "scratch");

    await sql`
      UPDATE "environments"
      SET
        "status" = 'ready',
        "fly_app_name" = ${`kestrel-test-${suffix}`},
        "fly_network_name" = ${`kestrel-test-${suffix}`},
        "fly_gateway_machine_id" = ${`gateway-${suffix}`},
        "router_url" = 'https://environment.example',
        "router_image" = 'registry.example/kestrel-router@sha256:test',
        "runtime_image" = 'registry.example/kestrel-workspace@sha256:test'
      WHERE "id" = ${createdEnvironment.environment.id}
    `;
    await sql`
      UPDATE "environment_workspaces"
      SET
        "status" = 'ready',
        "fly_machine_id" = ${`machine-${suffix}`},
        "fly_volume_id" = ${`volume-${suffix}`},
        "runtime_image" = 'registry.example/kestrel-workspace@sha256:test'
      WHERE "id" = ${projectBinding.workspace.id}
    `;

    await assert.rejects(
      executionRoute.resolveEnvironmentExecutionRoute({
        organizationId: organizationA,
        threadId: projectThreadId,
        actorUserId: userA,
        agentId: "kestrel-one",
        recordExecution: { projectContextRevisionId: revisionId },
      }),
      /not enabled for this organization/u
    );
    await sql`
      UPDATE "organization_feature_flags"
      SET "enabled" = true, "updated_at" = now()
      WHERE "organization_id" = ${organizationA}
        AND "key" = 'hosted_environments'
    `;

    const route = await executionRoute.resolveEnvironmentExecutionRoute({
      organizationId: organizationA,
      threadId: projectThreadId,
      actorUserId: userA,
      agentId: "kestrel-one",
      recordExecution: { projectContextRevisionId: revisionId },
    });
    assert.equal(route.environmentId, createdEnvironment.environment.id);
    assert.equal(route.workspaceId, projectBinding.workspace.id);
    assert.equal(route.baseUrl, "https://environment.example");
    assert.ok(
      route.effectiveCapabilities.includes(
        "app:built_in.weather.getWeather:auto"
      )
    );
    assert.ok(
      route.effectiveCapabilities.includes(
        "app:built_in.knowledge_search.searchKnowledgeDocuments:auto"
      )
    );

    await sql`
      INSERT INTO "project_apps" (
        "project_id", "app_key", "enabled", "added_by_user_id"
      ) VALUES (
        ${projectId}, 'built_in.weather', false, ${userA}
      )
    `;
    const routeAfterWeatherDisabled =
      await executionRoute.resolveEnvironmentExecutionRoute({
        organizationId: organizationA,
        threadId: projectThreadId,
        actorUserId: userA,
        agentId: "kestrel-one",
        recordExecution: {},
      });
    assert.equal(
      routeAfterWeatherDisabled.effectiveCapabilities.some((capability) =>
        capability.startsWith("app:built_in.weather.")
      ),
      false
    );
    assert.ok(
      routeAfterWeatherDisabled.effectiveCapabilities.includes(
        "app:built_in.knowledge_search.searchKnowledgeDocuments:auto"
      )
    );

    const ticket = auth.verifyEnvironmentExecutionTicket({
      publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
      token: route.authToken,
    });
    assert.equal(ticket.organizationId, organizationA);
    assert.equal(ticket.threadId, projectThreadId);
    assert.equal(ticket.workspaceId, projectBinding.workspace.id);
    assert.equal(ticket.actorId, userA);
    assert.equal(ticket.agentId, "kestrel-one");

    const [execution] = await sql<
      Array<{
        organizationId: string;
        environmentId: string;
        workspaceId: string;
        threadId: string;
        projectId: string | null;
        projectContextRevisionId: string | null;
        actorId: string;
        runtimeImage: string;
        effectiveCapabilities: string[];
      }>
    >`
      SELECT
        "organization_id" AS "organizationId",
        "environment_id" AS "environmentId",
        "workspace_id" AS "workspaceId",
        "thread_id" AS "threadId",
        "project_id" AS "projectId",
        "project_context_revision_id" AS "projectContextRevisionId",
        "actor_id" AS "actorId",
        "runtime_image" AS "runtimeImage",
        "effective_capabilities" AS "effectiveCapabilities"
      FROM "environment_run_executions"
      WHERE "id" = ${route.runId}
    `;
    assert.deepEqual(execution, {
      organizationId: organizationA,
      environmentId: createdEnvironment.environment.id,
      workspaceId: projectBinding.workspace.id,
      threadId: projectThreadId,
      projectId,
      projectContextRevisionId: revisionId,
      actorId: userA,
      runtimeImage: "registry.example/kestrel-workspace@sha256:test",
      effectiveCapabilities: execution?.effectiveCapabilities,
    });
    assert.ok(execution?.effectiveCapabilities.includes("route:run.stream"));

    const idleAt = new Date("2026-07-13T12:00:00.000Z");
    const idleOperation = await environmentStore.requestWorkspaceIdleStop({
      organizationId: organizationA,
      environmentId: createdEnvironment.environment.id,
      workspaceId: projectBinding.workspace.id,
      machineId: `machine-${suffix}`,
      lastActivityAt: idleAt,
    });
    assert.equal(idleOperation?.type, "workspace.stop");
    assert.deepEqual(idleOperation?.input, {
      reason: "idle_timeout",
      lastActivityAt: idleAt.toISOString(),
      machineId: `machine-${suffix}`,
    });
    const [idleWorkspace] = await sql<
      Array<{ status: string; lastActivityAt: Date }>
    >`
      SELECT "status", "last_activity_at" AS "lastActivityAt"
      FROM "environment_workspaces"
      WHERE "id" = ${projectBinding.workspace.id}
    `;
    assert.equal(idleWorkspace?.status, "stopping");
    assert.equal(
      idleWorkspace?.lastActivityAt.toISOString(),
      idleAt.toISOString()
    );
    assert.equal(
      (
        await databaseEnvironmentProvisioningRepository.claimOperation(
          idleOperation?.id ?? ""
        )
      )?.id,
      idleOperation?.id
    );
    assert.equal(
      (
        await databaseEnvironmentProvisioningRepository.claimOperation(
          idleOperation?.id ?? ""
        )
      )?.id,
      idleOperation?.id
    );
    await assert.rejects(
      environmentStore.requestWorkspaceIdleStop({
        organizationId: organizationA,
        environmentId: createdEnvironment.environment.id,
        workspaceId: projectBinding.workspace.id,
        machineId: "another-machine",
        lastActivityAt: idleAt,
      }),
      /does not match the provisioned Machine/u
    );
    await sql`
      DELETE FROM "environment_operations"
      WHERE "id" = ${idleOperation?.id ?? ""}
    `;
    await sql`
      UPDATE "environment_workspaces"
      SET "status" = 'stopped'
      WHERE "id" = ${projectBinding.workspace.id}
    `;
    await assert.rejects(
      environmentStore.requestWorkspaceIdleStop({
        organizationId: organizationA,
        environmentId: createdEnvironment.environment.id,
        workspaceId: projectBinding.workspace.id,
        machineId: `machine-${suffix}`,
        lastActivityAt: idleAt,
      }),
      /cannot enter idle stop from 'stopped'/u
    );
    await sql`
      UPDATE "environment_workspaces"
      SET "status" = 'ready'
      WHERE "id" = ${projectBinding.workspace.id}
    `;

    const [preservedThread] = await sql<
      Array<{ id: string; projectId: string | null }>
    >`
      SELECT "id", "project_id" AS "projectId"
      FROM "threads"
      WHERE "id" = ${projectThreadId}
    `;
    assert.deepEqual(preservedThread, { id: projectThreadId, projectId });

    await sql`
      INSERT INTO "account" (
        "id", "accountId", "providerId", "userId", "scope",
        "createdAt", "updatedAt"
      ) VALUES (
        ${githubAccountId}, 'github-user-42', 'github', ${userA}, 'repo',
        ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "app_installations" (
        "organization_id", "app_key", "status", "installed_by_user_id"
      ) VALUES (
        ${organizationA}, 'github', 'installed', ${userA}
      )
    `;
    await sql`
      INSERT INTO "app_connections" (
        "id", "organization_id", "app_key", "owner_type", "user_id",
        "auth_account_id", "name", "status", "external_account_id",
        "external_account_label", "scopes"
      ) VALUES (
        ${githubConnectionId}, ${organizationA}, 'github', 'personal', ${userA},
        ${githubAccountId}, 'environment-user-a', 'connected', 'github-user-42',
        'environment-user-a', ${sql.json(["repo"])}
      )
    `;
    await sql`
      INSERT INTO "app_connection_resources" (
        "id", "connection_id", "external_id", "resource_type", "label",
        "permissions", "metadata"
      ) VALUES (
        ${repositoryResourceId}, ${githubConnectionId}, 'repository:acme/support',
        'repository', 'acme/support',
        ${sql.json({ pull: true, push: true, admin: false })},
        ${sql.json({ defaultBranch: "main", private: true })}
      )
    `;
    await sql`
      INSERT INTO "project_apps" (
        "project_id", "app_key", "enabled", "added_by_user_id"
      ) VALUES (${projectId}, 'github', true, ${userA})
    `;
    await sql`
      INSERT INTO "project_app_connections" (
        "project_id", "app_key", "connection_id", "scope", "user_id",
        "is_default", "added_by_user_id"
      ) VALUES (
        ${projectId}, 'github', ${githubConnectionId}, 'personal', ${userA},
        true, ${userA}
      )
    `;
    await sql`
      UPDATE "environment_workspaces"
      SET
        "source_type" = 'github',
        "source_resource_id" = ${repositoryResourceId},
        "source_repository" = 'acme/support',
        "source_default_branch" = 'main'
      WHERE "id" = ${projectBinding.workspace.id}
    `;
    await sql`
      INSERT INTO "environment_app_capability_grants" (
        "environment_id", "app_key", "capability_key", "enabled",
        "approval_mode", "logging_mode", "rate_limit_mode"
      ) VALUES
        (${createdEnvironment.environment.id}, 'github', 'issue.write', true,
         'auto', 'metadata_only', 'default'),
        (${createdEnvironment.environment.id}, 'github', 'repository.read', true,
         'auto', 'metadata_only', 'default')
      ON CONFLICT ("environment_id", "app_key", "capability_key")
      DO UPDATE SET "enabled" = true, "approval_mode" = 'auto'
    `;

    const configuredScratchWorkspace =
      await environmentStore.createOrConfigureStandaloneThreadWorkspace({
        organizationId: organizationA,
        environmentId: createdEnvironment.environment.id,
        threadId: configuredScratchThreadId,
        userId: userA,
        source: { type: "github", resourceId: repositoryResourceId },
      });
    assert.equal(
      configuredScratchWorkspace.binding.threadId,
      configuredScratchThreadId
    );
    assert.equal(configuredScratchWorkspace.binding.source, "thread");
    assert.equal(
      configuredScratchWorkspace.workspace.standaloneThreadId,
      configuredScratchThreadId
    );
    assert.equal(configuredScratchWorkspace.workspace.sourceType, "github");
    assert.equal(
      configuredScratchWorkspace.workspace.sourceResourceId,
      repositoryResourceId
    );
    assert.equal(
      configuredScratchWorkspace.workspace.sourceRepository,
      "acme/support"
    );
    assert.equal(
      configuredScratchWorkspace.workspace.sourceDefaultBranch,
      "main"
    );
    assert.equal(configuredScratchWorkspace.operation.status, "queued");
    const resolvedConfiguredScratch =
      await environmentStore.resolveOrCreateThreadExecutionBinding({
        organizationId: organizationA,
        threadId: configuredScratchThreadId,
        userId: userA,
      });
    assert.equal(resolvedConfiguredScratch.created, false);
    assert.equal(
      resolvedConfiguredScratch.workspace.id,
      configuredScratchWorkspace.workspace.id
    );
    await sql`
      INSERT INTO "project_app_capability_policies" (
        "project_id", "app_key", "capability_key", "enabled",
        "approval_mode", "logging_mode", "rate_limit_mode"
      ) VALUES (
        ${projectId}, 'github', 'issue.write', true, 'auto',
        'metadata_only', 'default'
      )
    `;
    await sql`
      INSERT INTO "environment_capability_subject_restrictions" (
        "id", "organization_id", "environment_id", "subject_type",
        "subject_id", "provider_key", "capability_key", "resource_id",
        "enabled", "approval_mode"
      ) VALUES
        (
          ${actorRestrictionId}, ${organizationA},
          ${createdEnvironment.environment.id}, 'actor', ${userA}, 'github',
          'issue.write', NULL, true, 'auto'
        ),
        (
          ${agentRestrictionId}, ${organizationA},
          ${createdEnvironment.environment.id}, 'agent', 'kestrel-one',
          'github', 'issue.write', NULL, true, 'auto'
        )
    `;

    const authorizationInput = {
      ticket,
      repository: "acme/support",
      capability: "issue.write" as const,
      requireRunExecution: true,
    };
    const authorization =
      await githubPolicy.authorizeGitHubCapability(authorizationInput);
    assert.equal(authorization.resource.id, repositoryResourceId);
    assert.equal(authorization.connection.id, githubConnectionId);
    assert.equal(authorization.approvalMode, "ask");

    const assertGitHubDenied = async (code: string) => {
      await assert.rejects(
        githubPolicy.authorizeGitHubCapability(authorizationInput),
        (error: unknown) =>
          error instanceof githubPolicy.GitHubPolicyError && error.code === code
      );
    };
    await sql`
      UPDATE "environment_capability_subject_restrictions"
      SET "enabled" = false
      WHERE "id" = ${actorRestrictionId}
    `;
    await assertGitHubDenied("GITHUB_RESTRICTION_DENIED");
    await sql`
      UPDATE "environment_capability_subject_restrictions"
      SET "enabled" = true
      WHERE "id" = ${actorRestrictionId}
    `;
    await sql`
      UPDATE "environment_capability_subject_restrictions"
      SET "enabled" = false
      WHERE "id" = ${agentRestrictionId}
    `;
    await assertGitHubDenied("GITHUB_RESTRICTION_DENIED");
    await sql`
      UPDATE "environment_capability_subject_restrictions"
      SET "enabled" = true
      WHERE "id" = ${agentRestrictionId}
    `;
    await sql`
      UPDATE "project_app_capability_policies"
      SET "enabled" = false
      WHERE "project_id" = ${projectId}
        AND "app_key" = 'github'
        AND "capability_key" = 'issue.write'
    `;
    await assertGitHubDenied("GITHUB_CAPABILITY_DENIED");
    await sql`
      UPDATE "project_app_capability_policies"
      SET "enabled" = true
      WHERE "project_id" = ${projectId}
        AND "app_key" = 'github'
        AND "capability_key" = 'issue.write'
    `;
    await sql`
      UPDATE "app_connections"
      SET "status" = 'disconnected'
      WHERE "id" = ${githubConnectionId}
    `;
    await assertGitHubDenied("GITHUB_CAPABILITY_DENIED");
    await sql`
      UPDATE "app_connections"
      SET "status" = 'connected'
      WHERE "id" = ${githubConnectionId}
    `;
    await sql`
      UPDATE "environment_app_capability_grants"
      SET "enabled" = false, "approval_mode" = 'deny'
      WHERE "environment_id" = ${createdEnvironment.environment.id}
        AND "app_key" = 'github'
        AND "capability_key" = 'issue.write'
    `;
    await assertGitHubDenied("GITHUB_CAPABILITY_DENIED");

    await assert.rejects(
      environmentStore.resolveOrCreateThreadExecutionBinding({
        organizationId: organizationB,
        threadId: projectThreadId,
        userId: userB,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ENVIRONMENT_BINDING_NOT_FOUND"
    );

    const secondary = await environmentStore.createOrganizationEnvironment({
      organizationId: organizationA,
      userId: userA,
      environment: {
        name: "Secondary Environment",
        region: "iad",
        isDefault: false,
      },
    });
    await sql`
      UPDATE "environments"
      SET "status" = 'ready'
      WHERE "id" = ${secondary.environment.id}
    `;
    await assert.rejects(
      databaseEnvironmentProvisioningRepository.setEnvironmentDeleting(
        createdEnvironment.environment.id
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ENVIRONMENT_IS_DEFAULT"
    );
    const projectOwned = await environmentStore.createOrganizationEnvironment({
      organizationId: organizationA,
      userId: userA,
      environment: {
        name: "Project-owned Environment",
        region: "iad",
        isDefault: false,
      },
    });
    const ownedProjectId = `owned-project-${suffix}`;
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE "environments"
        SET "status" = 'ready'
        WHERE "id" = ${projectOwned.environment.id}
      `;
      await transaction`
        INSERT INTO "projects" (
          "id", "organization_id", "environment_id", "created_by_user_id", "name"
        ) VALUES (
          ${ownedProjectId}, ${organizationA}, ${projectOwned.environment.id},
          ${userA}, 'Owned Project'
        )
      `;
      await transaction`
        INSERT INTO "project_members" (
          "project_id", "organization_member_id", "role"
        ) VALUES (${ownedProjectId}, ${memberA}, 'owner')
      `;
    });
    await assert.rejects(
      databaseEnvironmentProvisioningRepository.setEnvironmentDeleting(
        projectOwned.environment.id
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ENVIRONMENT_HAS_PROJECTS"
    );
    const [projectOwnedAfterConflict] = await sql<Array<{ status: string }>>`
      SELECT "status"
      FROM "environments"
      WHERE "id" = ${projectOwned.environment.id}
    `;
    assert.equal(projectOwnedAfterConflict?.status, "ready");
    const lifecycleRace = await Promise.allSettled([
      environmentStore.setDefaultOrganizationEnvironment({
        organizationId: organizationA,
        environmentId: secondary.environment.id,
      }),
      databaseEnvironmentProvisioningRepository.setEnvironmentDeleting(
        secondary.environment.id
      ),
    ]);
    assert.equal(
      lifecycleRace.filter((result) => result.status === "fulfilled").length,
      1
    );
    const [racedEnvironment] = await sql<
      Array<{ status: string; isDefault: boolean }>
    >`
      SELECT "status", "is_default" AS "isDefault"
      FROM "environments"
      WHERE "id" = ${secondary.environment.id}
    `;
    assert.ok(racedEnvironment);
    assert.equal(
      racedEnvironment.status === "deleting" && racedEnvironment.isDefault,
      false,
      "a deleting Environment must never become the organization default"
    );

    const automaticTarget =
      await environmentStore.createOrganizationEnvironment({
        organizationId: organizationB,
        userId: userB,
        environment: {
          name: "Automatic default candidate",
          region: "iad",
          isDefault: false,
        },
      });
    await sql`
      UPDATE "environments"
      SET "status" = 'ready'
      WHERE "id" = ${automaticTarget.environment.id}
    `;
    const automaticDefaultRace = await Promise.allSettled([
      environmentStore.ensureOrganizationDefaultEnvironment({
        organizationId: organizationB,
        userId: userB,
      }),
      databaseEnvironmentProvisioningRepository.setEnvironmentDeleting(
        automaticTarget.environment.id
      ),
    ]);
    const ensuredDefault = automaticDefaultRace[0];
    assert.equal(ensuredDefault.status, "fulfilled");
    const [automaticTargetAfterRace] = await sql<
      Array<{ status: string; isDefault: boolean }>
    >`
      SELECT "status", "is_default" AS "isDefault"
      FROM "environments"
      WHERE "id" = ${automaticTarget.environment.id}
    `;
    assert.ok(automaticTargetAfterRace);
    assert.equal(
      automaticTargetAfterRace.status === "deleting" &&
        automaticTargetAfterRace.isDefault,
      false,
      "automatic default selection must not claim a deleting Environment"
    );
    if (automaticDefaultRace[1]?.status === "fulfilled") {
      assert.notEqual(
        ensuredDefault.status === "fulfilled"
          ? ensuredDefault.value.environment.id
          : undefined,
        automaticTarget.environment.id
      );
    }
  }
);
