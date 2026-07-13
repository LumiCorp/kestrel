import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test(
  "hosted Environment bindings preserve Thread identity and reject cross-organization resolution",
  {
    skip: databaseUrl
      ? false
      : "KESTREL_ENVIRONMENT_DB_TEST_URL is not configured",
  },
  async (context) => {
    assert.ok(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");
    process.env.KESTREL_ENVIRONMENTS_ENABLED = "true";
    process.env.KESTREL_ENVIRONMENT_ROUTER_URL = "http://127.0.0.1:43106";

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();

    const [
      { resetDbRuntimeForTests },
      environmentStore,
      executionRoute,
      auth,
      githubPolicy,
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./store"),
      import("./execution-route"),
      import("@lumi/kestrel-environment-auth"),
      import("@/lib/integrations/github-policy"),
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
    const revisionId = `revision-${suffix}`;
    const repositoryResourceId = crypto.randomUUID();
    const environmentGrantId = crypto.randomUUID();
    const projectRestrictionId = crypto.randomUUID();
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
      await transaction`
        INSERT INTO "projects" (
          "id", "organization_id", "created_by_user_id", "name"
        ) VALUES (${projectId}, ${organizationA}, ${userA}, 'Environment Project')
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
          )
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

    const route = await executionRoute.resolveEnvironmentExecutionRoute({
      organizationId: organizationA,
      threadId: projectThreadId,
      actorUserId: userA,
      agentId: "kestrel-one",
      recordExecution: { projectContextRevisionId: revisionId },
    });
    assert.equal(route.environmentId, createdEnvironment.environment.id);
    assert.equal(route.workspaceId, projectBinding.workspace.id);

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

    const [preservedThread] = await sql<
      Array<{ id: string; projectId: string | null }>
    >`
      SELECT "id", "project_id" AS "projectId"
      FROM "threads"
      WHERE "id" = ${projectThreadId}
    `;
    assert.deepEqual(preservedThread, { id: projectThreadId, projectId });

    await sql`
      INSERT INTO "organization_tool_connections" (
        "organization_id", "provider_key", "auth_source", "status",
        "account_id", "metadata"
      ) VALUES (
        ${organizationA}, 'github', 'github_app', 'connected', 'installation-42',
        ${sql.json({ installationId: 42 })}
      )
    `;
    await sql`
      INSERT INTO "tool_connection_resources" (
        "id", "organization_id", "provider_key", "external_id",
        "resource_type", "label", "metadata"
      ) VALUES (
        ${repositoryResourceId}, ${organizationA}, 'github',
        'repository:acme/support', 'repository', 'acme/support',
        ${sql.json({ installationId: 42 })}
      )
    `;
    await sql`
      INSERT INTO "environment_capability_grants" (
        "id", "environment_id", "provider_key", "capability_key",
        "resource_id", "approval_mode"
      ) VALUES (
        ${environmentGrantId}, ${createdEnvironment.environment.id}, 'github',
        'issue.write', ${repositoryResourceId}, 'auto'
      )
    `;
    await sql`
      INSERT INTO "project_capability_restrictions" (
        "id", "project_id", "provider_key", "capability_key", "resource_id",
        "enabled", "approval_mode"
      ) VALUES (
        ${projectRestrictionId}, ${projectId}, 'github', 'issue.write',
        ${repositoryResourceId}, true, 'auto'
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
          'issue.write', ${repositoryResourceId}, true, 'auto'
        ),
        (
          ${agentRestrictionId}, ${organizationA},
          ${createdEnvironment.environment.id}, 'agent', 'kestrel-one',
          'github', 'issue.write', ${repositoryResourceId}, true, 'auto'
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
    assert.equal(authorization.installationId, 42);
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
      UPDATE "project_capability_restrictions"
      SET "enabled" = false
      WHERE "id" = ${projectRestrictionId}
    `;
    await assertGitHubDenied("GITHUB_RESTRICTION_DENIED");
    await sql`
      UPDATE "project_capability_restrictions"
      SET "enabled" = true
      WHERE "id" = ${projectRestrictionId}
    `;
    await sql`
      UPDATE "organization_tool_connections"
      SET "status" = 'disconnected'
      WHERE "organization_id" = ${organizationA} AND "provider_key" = 'github'
    `;
    await assertGitHubDenied("GITHUB_CONTEXT_DENIED");
    await sql`
      UPDATE "organization_tool_connections"
      SET "status" = 'connected'
      WHERE "organization_id" = ${organizationA} AND "provider_key" = 'github'
    `;
    await sql`
      DELETE FROM "environment_capability_grants"
      WHERE "id" = ${environmentGrantId}
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
  }
);
