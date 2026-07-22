import "server-only";

import { readKestrelTerminalInteraction } from "@kestrel-agents/ai-sdk";
import type { RunnerRunTerminalEvent } from "@kestrel-agents/sdk";
import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { recordAppOperationApprovalRequest } from "./app-operation-approvals";
import { resolveEffectiveProjectAppAccess } from "./project-service";

const EMAIL_APPROVAL_TTL_MS = 5 * 60_000;

export async function recordEmailAppApprovalRequest(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  actorUserId: string;
  agentId: string;
  requestedExecutionId: string;
  event: RunnerRunTerminalEvent;
}) {
  const interaction = readKestrelTerminalInteraction(input.event);
  const approval = interaction?.approval;
  if (
    !(
      interaction?.kind === "approval" &&
      approval?.toolName === "kestrel_one.email_send"
    )
  ) {
    return null;
  }
  const payload = asRecord(approval.input);
  if (!payload) return null;
  const thread = await knowledgeDb.query.threads.findFirst({
    where: and(
      eq(schema.threads.id, input.threadId),
      eq(schema.threads.organizationId, input.organizationId)
    ),
    columns: { projectId: true },
  });
  if (!thread?.projectId) return null;
  const access = await resolveEffectiveProjectAppAccess({
    organizationId: input.organizationId,
    projectId: thread.projectId,
    appKey: "email",
    userId: input.actorUserId,
  });
  const capability = access?.capabilities.find(
    (candidate) => candidate.key === "send"
  );
  if (!(access?.connectionId && capability?.approvalMode === "ask")) {
    return null;
  }
  const resource = await knowledgeDb.query.appConnectionResources.findFirst({
    where: and(
      eq(schema.appConnectionResources.connectionId, access.connectionId),
      eq(schema.appConnectionResources.resourceType, "sender"),
      eq(schema.appConnectionResources.enabled, true)
    ),
    columns: { id: true },
  });
  if (!resource) return null;
  return recordAppOperationApprovalRequest({
    projectId: thread.projectId,
    requestedExecutionId: input.requestedExecutionId,
    expiresAt: new Date(Date.now() + EMAIL_APPROVAL_TTL_MS),
    binding: {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      actorUserId: input.actorUserId,
      agentId: input.agentId,
      appKey: "email",
      capabilityKey: "send",
      connectionId: access.connectionId,
      resourceId: resource.id,
      resourceType: "sender",
      operationKey: "email.send",
      runtimeApprovalId: interaction.requestId,
      payload,
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
