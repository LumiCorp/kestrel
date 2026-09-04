import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ensureCoreAppCatalog } from "../../lib/apps/service.js";

export async function seedBrowser(sql: postgres.Sql) {
  const ids = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    memberId: randomUUID(),
    environmentId: randomUUID(),
    projectId: randomUUID(),
    threadId: randomUUID(),
    workspaceId: randomUUID(),
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
  };
  const now = new Date();
  await ensureCoreAppCatalog();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (${ids.userId}, 'Browser test', ${`${ids.userId}@example.test`}, true, ${now}, ${now})`;
    await tx`INSERT INTO organization (id, name, slug, "createdAt") VALUES (${ids.organizationId}, 'Browser test', ${ids.organizationId}, ${now})`;
    await tx`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES (${ids.memberId}, ${ids.organizationId}, ${ids.userId}, 'owner', ${now})`;
    await tx`INSERT INTO environments (id, organization_id, created_by_user_id, name, slug, region, status, provider, fly_app_name, fly_gateway_machine_id, runtime_image) VALUES (${ids.environmentId}, ${ids.organizationId}, ${ids.userId}, 'Browser test', ${ids.environmentId}, 'iad', 'ready', 'fly', 'browser-test', 'gateway', 'test-workspace')`;
    await tx`INSERT INTO projects (id, organization_id, environment_id, created_by_user_id, name) VALUES (${ids.projectId}, ${ids.organizationId}, ${ids.environmentId}, ${ids.userId}, 'Browser test')`;
    await tx`INSERT INTO project_members (project_id, organization_member_id, role) VALUES (${ids.projectId}, ${ids.memberId}, 'owner')`;
    await tx`INSERT INTO project_apps (project_id, app_key, enabled, added_by_user_id, settings) VALUES (${ids.projectId}, 'built_in.browser', true, ${ids.userId}, '{}'::jsonb)`;
    const settings = {
      enabledModes: ["operator"],
      personalGrantsEnabled: true,
      configuredPublicDomains: [
        {
          version: "browser_public_domain_authority_v1",
          scheme: "https",
          canonicalDomain: "example.com",
          includeSubdomains: true,
          port: 443,
        },
      ],
      blockedPublicDomains: [],
    };
    await tx`INSERT INTO environment_app_capability_grants (environment_id, app_key, capability_key, enabled, approval_mode, logging_mode, rate_limit_mode, settings) VALUES (${ids.environmentId}, 'built_in.browser', 'request_grant', true, 'auto', 'metadata_only', 'off', ${tx.json(settings)})`;
    await tx`INSERT INTO project_app_capability_policies (project_id, app_key, capability_key, enabled, approval_mode, logging_mode, rate_limit_mode, settings) VALUES (${ids.projectId}, 'built_in.browser', 'request_grant', true, 'auto', 'metadata_only', 'off', ${tx.json({ enabledModes: ["operator"], personalGrantsEnabled: true, blockedPublicDomains: [] })})`;
    await tx`INSERT INTO threads (id, title, created_by_user_id, organization_id, project_id) VALUES (${ids.threadId}, 'Browser test', ${ids.userId}, ${ids.organizationId}, ${ids.projectId})`;
    await tx`INSERT INTO environment_workspaces (id, organization_id, environment_id, project_id, created_by_user_id, name, kind, status, runtime_image) VALUES (${ids.workspaceId}, ${ids.organizationId}, ${ids.environmentId}, ${ids.projectId}, ${ids.userId}, 'Browser test', 'project', 'ready', 'test-workspace')`;
    await tx`INSERT INTO environment_run_executions (id, organization_id, environment_id, workspace_id, thread_id, project_id, actor_id, runtime_image, effective_capabilities, runtime_run_id, status) VALUES (${ids.executionId}, ${ids.organizationId}, ${ids.environmentId}, ${ids.workspaceId}, ${ids.threadId}, ${ids.projectId}, ${ids.userId}, 'test-workspace', '[]'::jsonb, ${ids.runId}, 'running')`;
    await tx`INSERT INTO thread_messages (id, thread_id, role, author_user_id, parts, source) VALUES (${ids.turnId}, ${ids.threadId}, 'user', ${ids.userId}, '[{"type":"text","text":"Browser local test"}]'::jsonb, 'web')`;
    await tx`INSERT INTO thread_turns (id, organization_id, thread_id, author_user_id, input_message_id, environment_execution_id, requested_environment_id, idempotency_key, sequence, queue_ordinal, status) VALUES (${ids.turnId}, ${ids.organizationId}, ${ids.threadId}, ${ids.userId}, ${ids.turnId}, ${ids.executionId}, ${ids.environmentId}, ${ids.turnId}, 1, 1, 'running')`;
    await tx`UPDATE thread_messages SET turn_id = ${ids.turnId} WHERE id = ${ids.turnId}`;
    await tx`INSERT INTO thread_turn_queue_state (thread_id, active_turn_id, next_sequence, state) VALUES (${ids.threadId}, ${ids.turnId}, 2, 'running')`;
  });
  return ids;
}
