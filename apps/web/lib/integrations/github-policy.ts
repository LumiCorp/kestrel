import "server-only";

import { and, eq, isNull, or } from "drizzle-orm";
import { resolveEffectiveProjectAppAccess } from "@/lib/apps/project-service";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  type GitHubCapability,
  intersectApprovalModes,
  requiresExplicitApproval,
} from "./github-policy-contract";

export type { GitHubCapability } from "./github-policy-contract";

export class GitHubPolicyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 403) {
    super(code);
    this.name = "GitHubPolicyError";
    this.code = code;
    this.status = status;
  }
}

type GitHubPolicyIdentity = {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
  actorId: string;
  agentId: string;
};

export async function authorizeGitHubCapability(input: {
  ticket: GitHubPolicyIdentity;
  repository: string;
  capability: GitHubCapability;
  requireRunExecution?: boolean | undefined;
}) {
  const { ticket } = input;
  const thread = await knowledgeDb.query.threads.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, ticket.threadId),
        eq(table.organizationId, ticket.organizationId)
      ),
    columns: { id: true, projectId: true },
  });
  if (!thread?.projectId) {
    throw new GitHubPolicyError("GITHUB_CONTEXT_DENIED");
  }
  const access = await resolveEffectiveProjectAppAccess({
    organizationId: ticket.organizationId,
    projectId: thread.projectId,
    appKey: "github",
    userId: ticket.actorId,
  });
  const capability = access?.capabilities.find(
    (candidate) => candidate.key === input.capability
  );
  if (
    !(access?.connectionId && capability) ||
    access.environmentId !== ticket.environmentId
  ) {
    throw new GitHubPolicyError("GITHUB_CAPABILITY_DENIED");
  }
  const connectionId = access.connectionId;
  const [connection, workspace, binding, resource, subjectRestrictions] =
    await Promise.all([
      knowledgeDb.query.appConnections.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, connectionId),
            eq(table.organizationId, ticket.organizationId),
            eq(table.appKey, "github"),
            eq(table.ownerType, "personal"),
            eq(table.userId, ticket.actorId),
            eq(table.status, "connected")
          ),
      }),
      knowledgeDb.query.environmentWorkspaces.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, ticket.workspaceId),
            eq(table.environmentId, ticket.environmentId),
            eq(table.organizationId, ticket.organizationId),
            eq(table.projectId, thread.projectId!)
          ),
        columns: { id: true, sourceResourceId: true },
      }),
      knowledgeDb.query.threadExecutionBindings.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.threadId, ticket.threadId),
            eq(table.organizationId, ticket.organizationId),
            eq(table.environmentId, ticket.environmentId),
            eq(table.workspaceId, ticket.workspaceId)
          ),
        columns: { threadId: true },
      }),
      knowledgeDb.query.appConnectionResources.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.connectionId, connectionId),
            eq(table.externalId, `repository:${input.repository}`),
            eq(table.resourceType, "repository"),
            eq(table.enabled, true)
          ),
      }),
      knowledgeDb
        .select()
        .from(schema.environmentCapabilitySubjectRestrictions)
        .where(
          and(
            eq(
              schema.environmentCapabilitySubjectRestrictions.organizationId,
              ticket.organizationId
            ),
            eq(
              schema.environmentCapabilitySubjectRestrictions.environmentId,
              ticket.environmentId
            ),
            eq(
              schema.environmentCapabilitySubjectRestrictions.providerKey,
              "github"
            ),
            eq(
              schema.environmentCapabilitySubjectRestrictions.capabilityKey,
              input.capability
            ),
            or(
              and(
                eq(
                  schema.environmentCapabilitySubjectRestrictions.subjectType,
                  "actor"
                ),
                eq(
                  schema.environmentCapabilitySubjectRestrictions.subjectId,
                  ticket.actorId
                )
              ),
              and(
                eq(
                  schema.environmentCapabilitySubjectRestrictions.subjectType,
                  "agent"
                ),
                eq(
                  schema.environmentCapabilitySubjectRestrictions.subjectId,
                  ticket.agentId
                )
              )
            ),
            isNull(schema.environmentCapabilitySubjectRestrictions.resourceId)
          )
        ),
    ]);
  if (
    !(connection?.externalAccountId && workspace && binding && resource) ||
    workspace.sourceResourceId !== resource.id ||
    (input.capability === "repository.read" && !resource.permissions?.pull) ||
    (input.capability === "repository.push_agent_branch" &&
      !resource.permissions?.push)
  ) {
    throw new GitHubPolicyError("GITHUB_ACTOR_RESOURCE_DENIED");
  }
  if (input.requireRunExecution) {
    const execution =
      await knowledgeDb.query.environmentRunExecutions.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, ticket.runId),
            eq(table.organizationId, ticket.organizationId),
            eq(table.environmentId, ticket.environmentId),
            eq(table.workspaceId, ticket.workspaceId),
            eq(table.threadId, ticket.threadId),
            eq(table.actorId, ticket.actorId)
          ),
        columns: { id: true },
      });
    if (!execution) throw new GitHubPolicyError("GITHUB_RUN_DENIED");
  }
  if (subjectRestrictions.some((restriction) => !restriction.enabled)) {
    throw new GitHubPolicyError("GITHUB_RESTRICTION_DENIED");
  }
  const approvalMode = intersectApprovalModes([
    capability.approvalMode,
    ...subjectRestrictions.map((restriction) => restriction.approvalMode),
    ...(requiresExplicitApproval(input.capability) ? ["ask" as const] : []),
  ]);
  if (approvalMode === "deny") {
    throw new GitHubPolicyError("GITHUB_CAPABILITY_DENIED");
  }
  return {
    connection,
    providerAccountId: connection.externalAccountId,
    resource,
    approvalMode,
    loggingMode: capability.loggingMode,
    projectId: thread.projectId,
  };
}
