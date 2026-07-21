import assert from "node:assert/strict";
import postgres from "postgres";
import { hashGitHubActionPayload } from "./github-action-approval-contract";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

contractTest(
  "web.postgres", "GitHub action approval consumption is exact and single-use",
  async () => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const ids = {
      user: `approval-user-${suffix}`,
      otherUser: `approval-other-user-${suffix}`,
      organization: `approval-org-${suffix}`,
      environment: `approval-env-${suffix}`,
      thread: `approval-thread-${suffix}`,
      workspace: `approval-workspace-${suffix}`,
      requestedExecution: `approval-requested-run-${suffix}`,
      consumedExecution: `approval-consumed-run-${suffix}`,
      resource: `approval-resource-${suffix}`,
      approval: `approval-${suffix}`,
      runtimeApproval: `runtime-${suffix}:4:abc123`,
    };
    const payload = {
      operation: "issue.create",
      repository: "acme/widgets",
      title: "Canary",
    };
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (${ids.user}, 'Approval User', ${`${suffix}@example.test`}, true, now(), now())`;
        await tx`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (${ids.otherUser}, 'Other Approval User', ${`other-${suffix}@example.test`}, true, now(), now())`;
        await tx`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (${ids.organization}, 'Approval Org', ${`approval-org-${suffix}`}, now())`;
        await tx`INSERT INTO "threads" ("id", "created_by_user_id", "organization_id") VALUES (${ids.thread}, ${ids.user}, ${ids.organization})`;
        await tx`INSERT INTO "environments" ("id", "organization_id", "created_by_user_id", "name", "slug", "region", "status") VALUES (${ids.environment}, ${ids.organization}, ${ids.user}, 'Approval Environment', 'approval', 'iad', 'ready')`;
        await tx`INSERT INTO "environment_workspaces" ("id", "organization_id", "environment_id", "standalone_thread_id", "created_by_user_id", "name", "kind", "source_type", "status") VALUES (${ids.workspace}, ${ids.organization}, ${ids.environment}, ${ids.thread}, ${ids.user}, 'Approval Workspace', 'scratch', 'blank', 'ready')`;
        await tx`INSERT INTO "tool_connection_resources" ("id", "organization_id", "provider_key", "external_id", "resource_type", "label") VALUES (${ids.resource}, ${ids.organization}, 'github', ${`repository:acme/widgets:${suffix}`}, 'repository', 'acme/widgets')`;
        for (const executionId of [
          ids.requestedExecution,
          ids.consumedExecution,
        ]) {
          await tx`INSERT INTO "environment_run_executions" ("id", "organization_id", "environment_id", "workspace_id", "thread_id", "actor_id", "runtime_image", "effective_capabilities") VALUES (${executionId}, ${ids.organization}, ${ids.environment}, ${ids.workspace}, ${ids.thread}, ${ids.user}, 'registry.fly.io/kestrel@sha256:test', '[]'::jsonb)`;
        }
        await tx`INSERT INTO "github_action_approvals" ("id", "organization_id", "environment_id", "workspace_id", "thread_id", "requested_execution_id", "actor_user_id", "agent_id", "resource_id", "repository", "operation", "runtime_approval_id", "payload_hash", "payload", "status", "expires_at") VALUES (${ids.approval}, ${ids.organization}, ${ids.environment}, ${ids.workspace}, ${ids.thread}, ${ids.requestedExecution}, ${ids.user}, 'kestrel-one', ${ids.resource}, 'acme/widgets', 'issue.create', ${ids.runtimeApproval}, ${hashGitHubActionPayload(payload)}, ${sql.json(payload)}, 'pending', now() + interval '5 minutes')`;
      });

      const { consumeGitHubActionApproval, decideGitHubActionApproval } =
        await import("./github-action-approvals");
      await assert.rejects(
        () =>
          decideGitHubActionApproval({
            organizationId: ids.organization,
            threadId: ids.thread,
            userId: ids.otherUser,
            runtimeApprovalId: ids.runtimeApproval,
            approved: true,
          }),
        /GITHUB_APPROVAL_NOT_PENDING/u
      );
      const [stillPending] = await sql<
        Array<{ status: string }>
      >`SELECT "status" FROM "github_action_approvals" WHERE "id" = ${ids.approval}`;
      assert.equal(stillPending?.status, "pending");
      await decideGitHubActionApproval({
        organizationId: ids.organization,
        threadId: ids.thread,
        userId: ids.user,
        runtimeApprovalId: ids.runtimeApproval,
        approved: true,
      });
      const common = {
        identity: {
          organizationId: ids.organization,
          environmentId: ids.environment,
          workspaceId: ids.workspace,
          threadId: ids.thread,
          actorId: ids.user,
          agentId: "kestrel-one",
          runId: ids.consumedExecution,
        },
        runtimeApprovalId: ids.runtimeApproval,
        resourceId: ids.resource,
        repository: "acme/widgets",
        operation: "issue.create" as const,
      };
      await assert.rejects(
        () =>
          consumeGitHubActionApproval({
            ...common,
            payload: { ...payload, title: "Changed after approval" },
          }),
        /GITHUB_APPROVAL_INVALID/u
      );
      const consumed = await consumeGitHubActionApproval({
        ...common,
        payload,
      });
      assert.equal(consumed.status, "consumed");
      assert.equal(consumed.consumedExecutionId, ids.consumedExecution);
      await assert.rejects(
        () => consumeGitHubActionApproval({ ...common, payload }),
        /GITHUB_APPROVAL_INVALID/u
      );
    } finally {
      await sql`DELETE FROM "github_action_approvals" WHERE "organization_id" = ${ids.organization}`;
      await sql`DELETE FROM "organization" WHERE "id" = ${ids.organization}`;
      await sql`DELETE FROM "user" WHERE "id" IN (${ids.user}, ${ids.otherUser})`;
      await sql.end();
    }
  }
);
