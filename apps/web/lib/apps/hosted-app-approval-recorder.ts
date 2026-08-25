import "server-only";

import type { RunnerRunTerminalEvent } from "@kestrel-agents/sdk";
import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { authorizeGitHubCapability, type GitHubCapability } from "@/lib/integrations/github-policy";
import { recordAppOperationApprovalRequest } from "./app-operation-approvals";
import { parseHostedMutation } from "./hosted-app-operation-contract";
import { resolveEffectiveProjectAppAccess } from "./project-service";
import { parseTrustedTerminalApproval } from "./trusted-terminal-approval";

const APPROVAL_TTL_MS = 5 * 60_000;

export async function recordHostedAppApprovalRequest(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  actorUserId: string;
  agentId: string;
  requestedExecutionId: string;
  event: RunnerRunTerminalEvent;
}) {
  const terminal = parseTrustedTerminalApproval({
    event: input.event,
    threadId: input.threadId,
  });
  if (!terminal) return null;
  const operation = parseHostedMutation(terminal.toolName, terminal.toolInput);
  if (!operation) return null;
  const thread = await knowledgeDb.query.threads.findFirst({
    where: and(
      eq(schema.threads.id, input.threadId),
      eq(schema.threads.organizationId, input.organizationId),
    ),
    columns: { projectId: true },
  });
  if (!thread?.projectId) {
    throw new Error("HOSTED_APPROVAL_PROJECT_REQUIRED");
  }

  let connectionId: string;
  let resourceId: string;
  if (operation.appKey === "github") {
    if (!operation.resourceLabel) throw new Error("HOSTED_APPROVAL_RESOURCE_INVALID");
    const policy = await authorizeGitHubCapability({
      ticket: {
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        actorId: input.actorUserId,
        agentId: input.agentId,
        runId: input.requestedExecutionId,
      },
      repository: operation.resourceLabel,
      capability: operation.capabilityKey as GitHubCapability,
      requireRunExecution: true,
    });
    connectionId = policy.connection.id;
    resourceId = policy.resource.id;
  } else {
    const access = await resolveEffectiveProjectAppAccess({
      organizationId: input.organizationId,
      projectId: thread.projectId,
      appKey: operation.appKey,
      userId: input.actorUserId,
      includePolicyOnly: true,
    });
    const capability = access?.capabilities.find(
      (candidate) => candidate.key === operation.capabilityKey,
    );
    if (!(access?.connectionId && capability && capability.approvalMode !== "deny")) {
      throw new Error("HOSTED_APPROVAL_APP_ACCESS_DENIED");
    }
    const resource = await knowledgeDb.query.appConnectionResources.findFirst({
      where: (table, { and: all, eq: equals }) => all(
        equals(table.connectionId, access.connectionId!),
        equals(table.resourceType, operation.resourceType),
        equals(table.enabled, true),
        ...(operation.resourceExternalId
          ? [equals(table.externalId, operation.resourceExternalId)]
          : []),
      ),
      columns: { id: true },
    });
    if (!resource) throw new Error("HOSTED_APPROVAL_RESOURCE_UNAVAILABLE");
    connectionId = access.connectionId;
    resourceId = resource.id;
  }

  const expiresAt = new Date(
    Math.min(terminal.expiresAt.getTime(), Date.now() + APPROVAL_TTL_MS),
  );
  const approval = await recordAppOperationApprovalRequest({
    projectId: thread.projectId,
    requestedExecutionId: input.requestedExecutionId,
    expiresAt,
    runtimeBinding: terminal.externalBinding,
    binding: {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      actorUserId: input.actorUserId,
      agentId: input.agentId,
      appKey: operation.appKey,
      capabilityKey: operation.capabilityKey,
      connectionId,
      resourceId,
      resourceType: operation.resourceType,
      operationKey: operation.operationKey,
      runtimeApprovalId: terminal.runtimeApprovalId,
      payload: operation.providerInput,
    },
  });
  return {
    requestId: terminal.requestId,
    runtimeApprovalId: terminal.runtimeApprovalId,
    sourceRuntimeRunId: terminal.runId,
    approvalId: approval.id,
  };
}
