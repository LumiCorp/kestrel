import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { mintGitHubInstallationToken } from "@/lib/integrations/github-app";
import {
  authorizeGitHubCapability,
  GitHubPolicyError,
} from "@/lib/integrations/github-policy";
import { errorResponse } from "@/lib/knowledge/http";

const inputSchema = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
  capability: z.enum(["repository.read", "repository.push_agent_branch"]),
});

export async function POST(request: Request) {
  let ticket: EnvironmentExecutionTicket | null = null;
  try {
    const token = readBearer(request.headers.get("authorization"));
    ticket = verifyEnvironmentExecutionTicket({
      token,
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    const body = inputSchema.parse(await request.json());
    const policy = await authorizeGitHubCapability({
      ticket,
      repository: body.repository,
      capability: body.capability,
      requireRunExecution: body.capability === "repository.push_agent_branch",
    });
    if (policy.approvalMode !== "auto") {
      return denied("GITHUB_APPROVAL_REQUIRED", 409);
    }
    const credential = await mintGitHubInstallationToken({
      installationId: policy.installationId,
      repository: body.repository,
      capability: body.capability,
    });
    await logAdminEvent({
      organizationId: ticket.organizationId,
      actorUserId: ticket.actorId,
      category: "environment-tools",
      action: "github.token.issued",
      targetType: "environment",
      targetId: ticket.environmentId,
      message: `Issued a short-lived GitHub installation token for ${body.repository}.`,
      metadata: {
        workspaceId: ticket.workspaceId,
        threadId: ticket.threadId,
        runId: ticket.runId,
        repository: body.repository,
        capability: body.capability,
        agentId: ticket.agentId,
        loggingMode: policy.loggingMode,
      },
    });
    return NextResponse.json(
      {
        token: credential.token,
        expiresAt: credential.expiresAt,
        repository: body.repository,
        capability: body.capability,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GitHubPolicyError) {
      if (ticket) {
        await logAdminEvent({
          organizationId: ticket.organizationId,
          actorUserId: ticket.actorId,
          category: "environment-tools",
          action: "github.access.denied",
          targetType: "environment",
          targetId: ticket.environmentId,
          message: "Denied a GitHub credential request by Environment policy.",
          metadata: {
            workspaceId: ticket.workspaceId,
            threadId: ticket.threadId,
            runId: ticket.runId,
            agentId: ticket.agentId,
            code: error.code,
          },
        }).catch(() => {});
      }
      return denied(error.code, error.status);
    }
    return errorResponse(error, 401);
  }
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) throw new Error("Environment execution ticket is required.");
  return match[1];
}

function denied(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status });
}
