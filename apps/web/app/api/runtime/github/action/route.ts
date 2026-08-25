import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { Octokit } from "@octokit/rest";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { auth } from "@/lib/auth";
import {
  AppOperationApprovalError,
  consumeAppOperationApproval,
} from "@/lib/apps/app-operation-approvals";
import { githubRuntimeActionInputSchema } from "@/lib/apps/hosted-app-operation-contract";
import {
  authorizeGitHubCapability,
  type GitHubCapability,
  GitHubPolicyError,
} from "@/lib/integrations/github-policy";
import { errorResponse } from "@/lib/knowledge/http";

const inputSchema = githubRuntimeActionInputSchema;

export async function POST(request: Request) {
  let ticket: EnvironmentExecutionTicket | null = null;
  let operation: z.infer<typeof inputSchema>["operation"] | null = null;
  try {
    ticket = verifyEnvironmentExecutionTicket({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    const input = inputSchema.parse(await request.json());
    operation = input.operation;
    const capability = capabilityForOperation(input.operation);
    const policy = await authorizeGitHubCapability({
      ticket,
      repository: input.repository,
      capability,
      requireRunExecution: true,
    });
    let consumedApprovalId: string | null = null;
    const runtimeApprovalId = readApprovalId(
      request.headers.get("x-kestrel-approval-id"),
    );
    if (policy.approvalMode === "ask" && runtimeApprovalId === null) {
      throw new GitHubPolicyError("GITHUB_APPROVAL_REQUIRED", 409);
    }
    if (input.operation !== "repository.read_file" && runtimeApprovalId !== null) {
      const consumed = await consumeAppOperationApproval({
        consumedExecutionId: ticket.runId,
        binding: {
          organizationId: ticket.organizationId,
          environmentId: ticket.environmentId,
          workspaceId: ticket.workspaceId,
          threadId: ticket.threadId,
          actorUserId: ticket.actorId,
          agentId: ticket.agentId,
          appKey: "github",
          capabilityKey: capability,
          connectionId: policy.connection.id,
          resourceId: policy.resource.id,
          resourceType: "repository",
          operationKey: input.operation,
          runtimeApprovalId,
          payload: input,
        },
      });
      consumedApprovalId = consumed.id;
    }
    const credential = await auth.api.getAccessToken({
      body: {
        providerId: "github",
        accountId: policy.providerAccountId,
        userId: ticket.actorId,
      },
    });
    const client = new Octokit({ auth: credential.accessToken });
    const [owner, repo] = input.repository.split("/") as [string, string];
    const result = await executeAction(client, { owner, repo, input });
    await logAdminEvent({
      organizationId: ticket.organizationId,
      actorUserId: ticket.actorId,
      category: "environment-tools",
      action: `github.${input.operation}`,
      targetType: "environment",
      targetId: ticket.environmentId,
      message: `Executed ${input.operation} for ${input.repository}.`,
      metadata: {
        workspaceId: ticket.workspaceId,
        threadId: ticket.threadId,
        runId: ticket.runId,
        agentId: ticket.agentId,
        repository: input.repository,
        capability,
        approvalMode: policy.approvalMode,
        approvalId: consumedApprovalId,
        loggingMode: policy.loggingMode,
      },
    });
    return NextResponse.json(
      { operation: input.operation, repository: input.repository, result },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (
      operation === "repository.read_file" &&
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 404
    ) {
      return NextResponse.json(
        { error: { code: "GITHUB_CONTENT_NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (
      error instanceof GitHubPolicyError ||
      error instanceof AppOperationApprovalError
    ) {
      if (ticket) {
        await logAdminEvent({
          organizationId: ticket.organizationId,
          actorUserId: ticket.actorId,
          category: "environment-tools",
          action: "github.access.denied",
          targetType: "environment",
          targetId: ticket.environmentId,
          message: "Denied a GitHub action by Environment policy.",
          metadata: {
            workspaceId: ticket.workspaceId,
            threadId: ticket.threadId,
            runId: ticket.runId,
            agentId: ticket.agentId,
            code: error.code,
          },
        }).catch(() => {});
      }
      return NextResponse.json(
        { error: { code: error.code } },
        {
          status:
            error instanceof GitHubPolicyError ? error.status : 409,
        }
      );
    }
    return errorResponse(error, 400);
  }
}

function capabilityForOperation(
  operation: z.infer<typeof inputSchema>["operation"]
): GitHubCapability {
  if (operation === "repository.read_file") return "repository.read";
  if (operation === "issue.create") return "issue.write";
  if (operation === "pull_request.create") return "pull_request.write";
  if (operation === "pull_request.merge") return "merge.write";
  if (operation === "release.create") return "release.write";
  return "workflow.dispatch";
}

async function executeAction(
  client: Octokit,
  input: {
    owner: string;
    repo: string;
    input: z.infer<typeof inputSchema>;
  }
) {
  const action = input.input;
  if (action.operation === "repository.read_file") {
    const response = await client.rest.repos.getContent({
      owner: input.owner,
      repo: input.repo,
      path: action.path,
      ...(action.ref ? { ref: action.ref } : {}),
    });
    if (Array.isArray(response.data)) {
      return {
        type: "directory",
        entries: response.data.map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type,
          sha: entry.sha,
        })),
      };
    }
    return {
      type: response.data.type,
      path: response.data.path,
      sha: response.data.sha,
      encoding: "encoding" in response.data ? response.data.encoding : null,
      content: "content" in response.data ? response.data.content : null,
    };
  }
  if (action.operation === "issue.create") {
    const response = await client.rest.issues.create({
      owner: input.owner,
      repo: input.repo,
      title: action.title,
      ...(action.body !== undefined ? { body: action.body } : {}),
    });
    return { number: response.data.number, url: response.data.html_url };
  }
  if (action.operation === "pull_request.create") {
    const response = await client.rest.pulls.create({
      owner: input.owner,
      repo: input.repo,
      title: action.title,
      head: action.head,
      base: action.base,
      ...(action.body !== undefined ? { body: action.body } : {}),
    });
    return { number: response.data.number, url: response.data.html_url };
  }
  if (action.operation === "pull_request.merge") {
    const response = await client.rest.pulls.merge({
      owner: input.owner,
      repo: input.repo,
      pull_number: action.pullNumber,
      ...(action.method ? { merge_method: action.method } : {}),
    });
    return {
      merged: response.data.merged,
      sha: response.data.sha,
      message: response.data.message,
    };
  }
  if (action.operation === "release.create") {
    const response = await client.rest.repos.createRelease({
      owner: input.owner,
      repo: input.repo,
      tag_name: action.tagName,
      ...(action.name !== undefined ? { name: action.name } : {}),
      ...(action.body !== undefined ? { body: action.body } : {}),
      ...(action.targetCommitish !== undefined
        ? { target_commitish: action.targetCommitish }
        : {}),
      draft: action.draft ?? false,
      prerelease: action.prerelease ?? false,
    });
    return { id: response.data.id, url: response.data.html_url };
  }
  await client.rest.actions.createWorkflowDispatch({
    owner: input.owner,
    repo: input.repo,
    workflow_id: action.workflowId,
    ref: action.ref,
    ...(action.inputs ? { inputs: action.inputs } : {}),
  });
  return { dispatched: true };
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) throw new Error("Environment execution ticket is required.");
  return match[1];
}

function readApprovalId(value: string | null) {
  const approvalId = value?.trim();
  return approvalId && approvalId.length <= 500 ? approvalId : null;
}
