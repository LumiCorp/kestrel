import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { Octokit } from "@octokit/rest";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { mintGitHubInstallationToken } from "@/lib/integrations/github-app";
import {
  authorizeGitHubCapability,
  type GitHubCapability,
  GitHubPolicyError,
} from "@/lib/integrations/github-policy";
import { errorResponse } from "@/lib/knowledge/http";

const repositorySchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/u);
const inputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("repository.read_file"),
    repository: repositorySchema,
    path: z.string().trim().min(1).max(4096),
    ref: z.string().trim().min(1).max(255).optional(),
  }),
  z.object({
    operation: z.literal("issue.create"),
    repository: repositorySchema,
    title: z.string().trim().min(1).max(256),
    body: z.string().max(65_536).optional(),
  }),
  z.object({
    operation: z.literal("pull_request.create"),
    repository: repositorySchema,
    title: z.string().trim().min(1).max(256),
    head: z.string().trim().min(1).max(255),
    base: z.string().trim().min(1).max(255),
    body: z.string().max(65_536).optional(),
  }),
  z.object({
    operation: z.literal("pull_request.merge"),
    repository: repositorySchema,
    pullNumber: z.number().int().positive(),
    method: z.enum(["merge", "squash", "rebase"]).optional(),
  }),
  z.object({
    operation: z.literal("release.create"),
    repository: repositorySchema,
    tagName: z.string().trim().min(1).max(255),
    name: z.string().trim().max(256).optional(),
    body: z.string().max(125_000).optional(),
    targetCommitish: z.string().trim().min(1).max(255).optional(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
  }),
  z.object({
    operation: z.literal("workflow.dispatch"),
    repository: repositorySchema,
    workflowId: z.union([z.string().trim().min(1).max(255), z.number().int()]),
    ref: z.string().trim().min(1).max(255),
    inputs: z.record(z.string(), z.string()).optional(),
  }),
]);

export async function POST(request: Request) {
  let ticket: EnvironmentExecutionTicket | null = null;
  try {
    ticket = verifyEnvironmentExecutionTicket({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    const input = inputSchema.parse(await request.json());
    const capability = capabilityForOperation(input.operation);
    const policy = await authorizeGitHubCapability({
      ticket,
      repository: input.repository,
      capability,
      requireRunExecution: true,
    });
    if (
      policy.approvalMode === "ask" &&
      request.headers.get("x-kestrel-runtime-approval") !== "confirmed"
    ) {
      throw new GitHubPolicyError("GITHUB_APPROVAL_REQUIRED", 409);
    }
    const credential = await mintGitHubInstallationToken({
      installationId: policy.installationId,
      repository: input.repository,
      capability,
    });
    const client = new Octokit({ auth: credential.token });
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
        loggingMode: policy.loggingMode,
      },
    });
    return NextResponse.json(
      { operation: input.operation, repository: input.repository, result },
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
        { status: error.status }
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
