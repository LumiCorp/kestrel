import "server-only";

import type { RunnerRunTerminalEvent } from "@kestrel-agents/sdk";
import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { authorizeGitHubCapability, type GitHubCapability } from "@/lib/integrations/github-policy";
import {
  capabilityForGmailOperation,
  gmailRuntimeInputSchema,
  hasGmailCapabilityScopes,
  type GmailCapability,
} from "@/lib/integrations/gmail-contract";
import {
  admitGmailExecutionRoute,
  authorizeGmailCapability,
} from "@/lib/integrations/gmail-policy";
import { prepareGmailMutation } from "@/lib/integrations/gmail-mutation-preparation";
import { resolveHostedPersonalProviderToken } from "@/lib/integrations/hosted-personal-oauth";
import {
  buildGmailApprovalPresentation,
  type HostedAppApprovalPresentation,
} from "./hosted-app-approval-presentation";
import { recordAppOperationApprovalRequest } from "./app-operation-approvals";
import {
  isHostedMutationToolName,
  parseHostedMutation,
} from "./hosted-app-operation-contract";
import { resolveEffectiveProjectAppAccess } from "./project-service";
import {
  parseTrustedTerminalApproval,
  readTrustedTerminalApprovalToolName,
} from "./trusted-terminal-approval";

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
  const toolName = readTrustedTerminalApprovalToolName(input.event);
  if (!isHostedMutationToolName(toolName)) return null;
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
  let approvalPayload = operation.providerInput;
  let presentation: HostedAppApprovalPresentation | undefined;
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
    if (
      operation.operationKey === "gmail.messages.send" ||
      operation.operationKey === "gmail.messages.reply"
    ) {
      const issuedAt = Math.floor(Date.now() / 1000);
      const ticket: EnvironmentExecutionTicket = {
        version: 1,
        audience: "kestrel-environment-router",
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        actorId: input.actorUserId,
        agentId: input.agentId,
        runId: input.requestedExecutionId,
        flyAppName: "approval-recorder",
        flyMachineId: "approval-recorder",
        capabilities: ["kestrel.tools.invoke"],
        issuedAt,
        expiresAt: issuedAt + 300,
        nonce: crypto.randomUUID(),
      };
      const gmailPolicy = await authorizeGmailCapability({
        ticket,
        capability: operation.capabilityKey as GmailCapability,
      });
      if (
        gmailPolicy.connection.id !== connectionId ||
        !gmailPolicy.connection.externalAccountId
      ) {
        throw new Error("HOSTED_APPROVAL_GMAIL_CONNECTION_DENIED");
      }
      await admitGmailExecutionRoute({
        ticket,
        projectAuthorized: true,
        gmailReadonlyGranted: hasGmailCapabilityScopes({
          grantedScopes: gmailPolicy.connection.scopes,
          capability: operation.capabilityKey as GmailCapability,
        }),
      });
      const gmailInput = gmailRuntimeInputSchema.parse(operation.providerInput);
      if (
        gmailInput.operation !== "gmail.messages.send" &&
        gmailInput.operation !== "gmail.messages.reply"
      ) {
        throw new Error("HOSTED_APPROVAL_GMAIL_OPERATION_DENIED");
      }
      const accessToken = await resolveHostedPersonalProviderToken({
        provider: "google_workspace",
        connectionId,
        organizationId: input.organizationId,
        projectId: thread.projectId,
        userId: input.actorUserId,
        operation: gmailInput.operation,
        gmailExecution: ticket,
      });
      const prepared = await prepareGmailMutation({
        accessToken: accessToken.accessToken,
        operation: gmailInput,
        threadId: input.threadId,
        organizationId: input.organizationId,
        userId: input.actorUserId,
      });
      approvalPayload = prepared.approvalPayload;
      presentation = buildGmailApprovalPresentation(prepared);
    }
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
      payload: approvalPayload,
    },
  });
  return {
    requestId: terminal.requestId,
    runtimeApprovalId: terminal.runtimeApprovalId,
    sourceRuntimeRunId: terminal.runId,
    approvalId: approval.id,
    ...(presentation === undefined ? {} : { presentation }),
  };
}
