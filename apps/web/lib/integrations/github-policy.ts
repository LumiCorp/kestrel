import "server-only";

import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { and, eq, isNull, or } from "drizzle-orm";
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

export async function authorizeGitHubCapability(input: {
  ticket: EnvironmentExecutionTicket;
  repository: string;
  capability: GitHubCapability;
  requireRunExecution?: boolean | undefined;
}) {
  const { ticket } = input;
  const [connection, environment, workspace, thread, resource] =
    await Promise.all([
      knowledgeDb.query.organizationToolConnections.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, ticket.organizationId),
            eq(table.providerKey, "github"),
            eq(table.status, "connected")
          ),
      }),
      knowledgeDb.query.environments.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, ticket.environmentId),
            eq(table.organizationId, ticket.organizationId)
          ),
        columns: { id: true },
      }),
      knowledgeDb.query.environmentWorkspaces.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, ticket.workspaceId),
            eq(table.environmentId, ticket.environmentId),
            eq(table.organizationId, ticket.organizationId)
          ),
        columns: { id: true },
      }),
      knowledgeDb.query.threads.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, ticket.threadId),
            eq(table.organizationId, ticket.organizationId)
          ),
        columns: { id: true, projectId: true },
      }),
      knowledgeDb.query.toolConnectionResources.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, ticket.organizationId),
            eq(table.providerKey, "github"),
            eq(table.resourceType, "repository"),
            eq(table.externalId, `repository:${input.repository}`),
            eq(table.enabled, true)
          ),
      }),
    ]);
  if (!(connection && environment && workspace && thread && resource)) {
    throw new GitHubPolicyError("GITHUB_CONTEXT_DENIED");
  }
  const binding = await knowledgeDb.query.threadExecutionBindings.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.threadId, ticket.threadId),
        eq(table.organizationId, ticket.organizationId),
        eq(table.environmentId, ticket.environmentId),
        eq(table.workspaceId, ticket.workspaceId)
      ),
    columns: { threadId: true },
  });
  if (!binding) throw new GitHubPolicyError("GITHUB_BINDING_DENIED");
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
  const grant = await knowledgeDb.query.environmentCapabilityGrants.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.environmentId, ticket.environmentId),
        eq(table.providerKey, "github"),
        eq(table.capabilityKey, input.capability),
        eq(table.resourceId, resource.id)
      ),
  });
  if (!grant) throw new GitHubPolicyError("GITHUB_CAPABILITY_DENIED");
  const [projectRestrictions, subjectRestrictions] = await Promise.all([
    thread.projectId
      ? knowledgeDb
          .select()
          .from(schema.projectCapabilityRestrictions)
          .where(
            and(
              eq(
                schema.projectCapabilityRestrictions.projectId,
                thread.projectId
              ),
              eq(schema.projectCapabilityRestrictions.providerKey, "github"),
              eq(
                schema.projectCapabilityRestrictions.capabilityKey,
                input.capability
              ),
              or(
                eq(
                  schema.projectCapabilityRestrictions.resourceId,
                  resource.id
                ),
                isNull(schema.projectCapabilityRestrictions.resourceId)
              )
            )
          )
      : Promise.resolve([]),
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
          or(
            eq(
              schema.environmentCapabilitySubjectRestrictions.resourceId,
              resource.id
            ),
            isNull(schema.environmentCapabilitySubjectRestrictions.resourceId)
          )
        )
      ),
  ]);
  const restrictions = [...projectRestrictions, ...subjectRestrictions];
  if (restrictions.some((restriction) => !restriction.enabled)) {
    throw new GitHubPolicyError("GITHUB_RESTRICTION_DENIED");
  }
  const approvalMode = intersectApprovalModes([
    grant.approvalMode,
    ...restrictions.map((restriction) => restriction.approvalMode),
    ...(requiresExplicitApproval(input.capability) ? ["ask" as const] : []),
  ]);
  if (approvalMode === "deny") {
    throw new GitHubPolicyError("GITHUB_CAPABILITY_DENIED");
  }
  return {
    resource,
    installationId: readInstallationId(resource.metadata),
    approvalMode,
    loggingMode: grant.loggingMode,
    projectId: thread.projectId,
  };
}

function readInstallationId(metadata: unknown) {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("installationId" in metadata) ||
    typeof metadata.installationId !== "number" ||
    !Number.isSafeInteger(metadata.installationId)
  ) {
    throw new GitHubPolicyError("GITHUB_INSTALLATION_INVALID", 500);
  }
  return metadata.installationId;
}
