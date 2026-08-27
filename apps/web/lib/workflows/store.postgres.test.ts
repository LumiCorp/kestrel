import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { withGatewayModelEconomicsProfile } from "@/lib/ai/model-economics-profile";
import {
  createStarterWorkflowDefinition,
  type WorkflowDefinition,
} from "./contracts";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

function toolDefinition(schedule = false): WorkflowDefinition {
  const starter = createStarterWorkflowDefinition();
  return {
    ...starter,
    nodes: starter.nodes.map((node) => {
      if (node.kind === "trigger" && schedule) {
        return {
          ...node,
          config: {
            mode: "schedule" as const,
            cronExpression: "0 * * * *",
            timeZone: "UTC",
          },
        };
      }
      return node.id === "kestrel-1"
        ? {
            id: node.id,
            label: "Create issue",
            kind: "tool" as const,
            position: node.position,
            config: {
              toolName: "github.issue.create",
              input: { title: "Workflow issue" },
            },
          }
        : node;
    }),
  };
}

function joinedDefinition(): WorkflowDefinition {
  return {
    version: 1,
    nodes: [
      {
        id: "trigger",
        kind: "trigger",
        label: "Run manually",
        position: { x: 340, y: 40 },
        config: { mode: "manual" },
      },
      {
        id: "branch-a",
        kind: "gate",
        label: "Branch A",
        position: { x: 140, y: 240 },
        config: { path: "trigger.branchA", operator: "exists" },
      },
      {
        id: "branch-b",
        kind: "gate",
        label: "Branch B",
        position: { x: 540, y: 240 },
        config: { path: "trigger.branchB", operator: "exists" },
      },
      {
        id: "join",
        kind: "join",
        label: "Join branches",
        position: { x: 340, y: 440 },
        config: { mode: "all" },
      },
      {
        id: "output",
        kind: "output",
        label: "Workflow output",
        position: { x: 340, y: 640 },
        config: {},
      },
    ],
    edges: [
      { id: "trigger-a", source: "trigger", target: "branch-a" },
      { id: "trigger-b", source: "trigger", target: "branch-b" },
      { id: "a-join", source: "branch-a", target: "join" },
      { id: "b-join", source: "branch-b", target: "join" },
      { id: "join-output", source: "join", target: "output" },
    ],
  };
}

test("workflow persistence enforces policy and resolves one latest run", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const previousMaxConnections = process.env.DB_DRIZZLE_MAX_CONNECTIONS;
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.DB_DRIZZLE_MAX_CONNECTIONS = "6";
  const [{ resetDbRuntimeForTests }, workflows, runtime] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./store"),
    import("./runtime"),
  ]);
  const sql = postgres(databaseUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const ids = {
    organization: `workflow-org-${suffix}`,
    environment: `workflow-environment-${suffix}`,
    project: `workflow-project-${suffix}`,
    context: `workflow-context-${suffix}`,
    gateway: `workflow-gateway-${suffix}`,
    safeModel: `workflow-safe-model-${suffix}`,
    glmModel: `workflow-glm-model-${suffix}`,
    user: `workflow-user-${suffix}`,
    member: `workflow-member-${suffix}`,
  };
  const now = new Date("2026-08-26T16:00:00.000Z");
  const safeMetadata = withGatewayModelEconomicsProfile({
    metadata: { context_length: 32_768, max_completion_tokens: 8192 },
    provider: "openrouter",
    model: "safe-workflow-model",
    approved: true,
    modality: "language",
  });
  const glmMetadata = withGatewayModelEconomicsProfile({
    metadata: { context_length: 32_768, max_completion_tokens: 8192 },
    provider: "openrouter",
    model: "z-ai/glm-5.2:free",
    approved: true,
    modality: "language",
  });
  assert.ok(safeMetadata);
  assert.ok(glmMetadata);

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${ids.organization}`;
    await sql`DELETE FROM "user" WHERE "id" = ${ids.user}`;
    await resetDbRuntimeForTests();
    if (previousMaxConnections === undefined) {
      delete process.env.DB_DRIZZLE_MAX_CONNECTIONS;
    } else {
      process.env.DB_DRIZZLE_MAX_CONNECTIONS = previousMaxConnections;
    }
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      VALUES (${ids.user}, 'Workflow User', ${`${ids.user}@example.test`}, true, ${now}, ${now})
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${ids.organization}, 'Workflow Org', ${ids.organization}, ${now})
    `;
    await transaction`
      INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
      VALUES (${ids.member}, ${ids.organization}, ${ids.user}, 'owner', ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "region", "status", "is_default", "fly_app_name", "router_url"
      ) VALUES (
        ${ids.environment}, ${ids.organization}, ${ids.user}, 'Workflow Environment',
        'workflow', 'iad', 'ready', true, ${`workflow-app-${suffix}`},
        'https://environment.example'
      )
    `;
    await transaction`
      INSERT INTO "projects" (
        "id", "organization_id", "environment_id", "created_by_user_id", "name"
      ) VALUES (
        ${ids.project}, ${ids.organization}, ${ids.environment}, ${ids.user},
        'Workflow Project'
      )
    `;
    await transaction`
      INSERT INTO "project_members" ("project_id", "organization_member_id", "role")
      VALUES (${ids.project}, ${ids.member}, 'owner')
    `;
    await transaction`
      INSERT INTO "project_context_revisions" (
        "id", "project_id", "revision", "project_name", "instructions",
        "created_by_user_id", "created_at"
      ) VALUES (
        ${ids.context}, ${ids.project}, 1, 'Workflow Project',
        'Execute workflow steps.', ${ids.user}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "ai_gateways" (
        "id", "organization_id", "environment_id", "provider", "display_name"
      ) VALUES (
        ${ids.gateway}, ${ids.organization}, NULL, 'openrouter', 'Workflow Gateway'
      )
    `;
    await transaction`
      INSERT INTO "ai_gateway_models" (
        "id", "organization_id", "gateway_id", "raw_model_id", "modality",
        "approved", "is_default", "metadata"
      ) VALUES
        (
          ${ids.safeModel}, ${ids.organization}, ${ids.gateway}, 'safe-workflow-model',
          'language', true, true,
          ${transaction.json(JSON.parse(JSON.stringify(safeMetadata)))}
        ),
        (
          ${ids.glmModel}, ${ids.organization}, ${ids.gateway}, 'z-ai/glm-5.2:free',
          'language', true, false,
          ${transaction.json(JSON.parse(JSON.stringify(glmMetadata)))}
        )
    `;
  });

  await assert.rejects(
    workflows.createProjectWorkflow({
      organizationId: ids.organization,
      projectId: ids.project,
      userId: ids.user,
      title: "Unsupported model",
      modelId: "openrouter/z-ai/glm-5.2:free",
      definition: createStarterWorkflowDefinition(),
    }),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "WORKFLOW_MODEL_UNSUPPORTED",
      ),
  );
  await assert.rejects(
    workflows.createProjectWorkflow({
      organizationId: ids.organization,
      projectId: ids.project,
      userId: ids.user,
      title: "Unavailable tool",
      modelId: "openrouter/safe-workflow-model",
      definition: toolDefinition(),
    }),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "WORKFLOW_TOOL_UNAVAILABLE",
      ),
  );

  const workflow = await workflows.createProjectWorkflow({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.user,
    title: "Safe workflow",
    modelId: "openrouter/safe-workflow-model",
    definition: createStarterWorkflowDefinition(),
  });
  assert.ok(workflow);
  const [version] = await sql<{ id: string }[]>`
    SELECT "id" FROM "project_workflow_versions"
    WHERE "workflow_id" = ${workflow.id} AND "version" = 1
  `;
  assert.ok(version);
  await sql`
    INSERT INTO "project_workflow_runs" (
      "id", "workflow_id", "workflow_version_id", "actor_user_id", "trigger",
      "environment_id_snapshot", "project_context_revision_id_snapshot",
      "model_id_snapshot", "status", "created_at", "updated_at"
    ) VALUES
      (${`older-${suffix}`}, ${workflow.id}, ${version.id}, ${ids.user}, 'manual',
       ${ids.environment}, ${ids.context}, 'openrouter/safe-workflow-model',
       'completed', ${new Date(now.getTime() - 1000)}, ${now}),
      (${`newer-${suffix}`}, ${workflow.id}, ${version.id}, ${ids.user}, 'manual',
       ${ids.environment}, ${ids.context}, 'openrouter/safe-workflow-model',
       'failed', ${now}, ${now})
  `;
  const direct = await workflows.getProjectWorkflowForUser({
    organizationId: ids.organization,
    userId: ids.user,
    workflowId: workflow.id,
  });
  assert.equal(direct.id, workflow.id);
  assert.equal(direct.latestRun?.id, `newer-${suffix}`);

  const joinedWorkflow = await workflows.createProjectWorkflow({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.user,
    title: "Joined workflow",
    modelId: "openrouter/safe-workflow-model",
    definition: joinedDefinition(),
  });
  const joinedRun = await workflows.createProjectWorkflowRun({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.user,
    workflowId: joinedWorkflow.id,
    requestId: `joined-${suffix}`,
    runInput: { branchA: "A is ready", branchB: "B is ready" },
  });
  const joined = await runtime.advanceProjectWorkflowRun(joinedRun.id);
  assert.equal(joined.terminal, true);
  assert.deepEqual(joined.turnIds, []);
  const manualInput = { branchA: "A is ready", branchB: "B is ready" };
  const branchInput = { trigger: manualInput };
  const branchAOutput = { passed: true, value: "A is ready" };
  const branchBOutput = { passed: true, value: "B is ready" };
  const merged = {
    "branch-a": branchAOutput,
    "branch-b": branchBOutput,
  };
  const joinedInputs = await sql<
    { nodeId: string; input: Record<string, unknown>; output: Record<string, unknown> }[]
  >`
    SELECT "node_id" AS "nodeId", "input", "output"
    FROM "project_workflow_step_runs"
    WHERE "workflow_run_id" = ${joinedRun.id}
      AND "node_id" IN ('branch-a', 'branch-b', 'join', 'output')
    ORDER BY "node_id"
  `;
  assert.deepEqual([...joinedInputs], [
    { nodeId: "branch-a", input: branchInput, output: branchAOutput },
    { nodeId: "branch-b", input: branchInput, output: branchBOutput },
    { nodeId: "join", input: merged, output: merged },
    { nodeId: "output", input: { join: merged }, output: { join: merged } },
  ]);
  const [completedJoinedRun] = await sql<
    { status: string; output: Record<string, unknown> }[]
  >`
    SELECT "status", "output" FROM "project_workflow_runs"
    WHERE "id" = ${joinedRun.id}
  `;
  assert.deepEqual(completedJoinedRun, {
    status: "completed",
    output: { join: merged },
  });

  await sql`
    UPDATE "project_workflow_versions"
    SET "definition" = ${sql.json(JSON.parse(JSON.stringify(toolDefinition(true))))}
    WHERE "id" = ${version.id}
  `;
  await sql`
    UPDATE "project_workflows"
    SET "enabled" = true, "cron_expression" = '0 * * * *', "time_zone" = 'UTC',
        "next_run_at" = ${new Date(now.getTime() - 1000)}
    WHERE "id" = ${workflow.id}
  `;
  await workflows.claimDueProjectWorkflowRuns(now);
  const [disabled] = await sql<{ enabled: boolean; nextRunAt: Date | null }[]>`
    SELECT "enabled", "next_run_at" AS "nextRunAt"
    FROM "project_workflows" WHERE "id" = ${workflow.id}
  `;
  assert.equal(disabled?.enabled, false);
  assert.equal(disabled?.nextRunAt, null);
  const [{ count }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS "count" FROM "project_workflow_runs"
    WHERE "workflow_id" = ${workflow.id}
  `;
  assert.equal(count, 2, "invalid scheduled admission does not create a run");
});
