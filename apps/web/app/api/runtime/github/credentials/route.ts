import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_MAX_TTL_SECONDS,
  signEnvironmentToolCredential,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  authorizeGitHubCapability,
  GitHubPolicyError,
} from "@/lib/integrations/github-policy";
import {
  githubCapabilityForCredentialRequest,
  githubCredentialOperationBinding,
  githubToolCredentialRequestSchema,
} from "@/lib/integrations/github-tool-credential-contract";
import { knowledgeDb } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(request: Request) {
  try {
    const executionTicket = verifyEnvironmentExecutionTicket({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    const input = githubToolCredentialRequestSchema.parse(await request.json());
    const capability = githubCapabilityForCredentialRequest(input);
    const resource = await knowledgeDb.query.toolConnectionResources.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.resourceId),
          eq(table.organizationId, executionTicket.organizationId),
          eq(table.providerKey, "github"),
          eq(table.resourceType, "repository"),
          eq(table.enabled, true)
        ),
    });
    if (!resource) {
      throw new GitHubPolicyError("GITHUB_CONTEXT_DENIED");
    }
    const policy = await authorizeGitHubCapability({
      ticket: executionTicket,
      repository: resource.label,
      capability,
      requireRunExecution: input.operation === "repository.push_agent_branch",
    });
    if (policy.approvalMode !== "auto") {
      throw new GitHubPolicyError("GITHUB_APPROVAL_REQUIRED", 409);
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(
      issuedAt + ENVIRONMENT_TOOL_CREDENTIAL_MAX_TTL_SECONDS,
      executionTicket.expiresAt
    );
    if (expiresAt <= issuedAt) {
      throw new GitHubPolicyError("GITHUB_EXECUTION_TICKET_EXPIRED", 401);
    }
    const token = signEnvironmentToolCredential({
      privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
      ticket: {
        version: 1,
        audience: ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
        organizationId: executionTicket.organizationId,
        environmentId: executionTicket.environmentId,
        workspaceId: executionTicket.workspaceId,
        threadId: executionTicket.threadId,
        runId: executionTicket.runId,
        actorId: executionTicket.actorId,
        agentId: executionTicket.agentId,
        providerKey: "github",
        resourceId: resource.id,
        capability,
        operation: input.operation,
        operationBinding: githubCredentialOperationBinding(input),
        issuedAt,
        expiresAt,
        nonce: crypto.randomUUID(),
      },
    });
    await logAdminEvent({
      organizationId: executionTicket.organizationId,
      actorUserId: executionTicket.actorId,
      category: "environment-tools",
      action: "github.credential.issued",
      targetType: "environment",
      targetId: executionTicket.environmentId,
      message: `Issued a scoped GitHub credential for ${resource.label}.`,
      metadata: {
        workspaceId: executionTicket.workspaceId,
        threadId: executionTicket.threadId,
        runId: executionTicket.runId,
        agentId: executionTicket.agentId,
        resourceId: resource.id,
        repository: resource.label,
        capability,
        operation: input.operation,
        expiresAt,
        loggingMode: policy.loggingMode,
      },
    });
    return NextResponse.json(
      { token, expiresAt },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GitHubPolicyError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status }
      );
    }
    return errorResponse(error, 401);
  }
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) throw new Error("Environment execution ticket is required.");
  return match[1];
}
