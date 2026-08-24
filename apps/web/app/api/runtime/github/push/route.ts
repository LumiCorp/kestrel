import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type EnvironmentToolCredentialTicket,
  verifyEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import { Octokit } from "@octokit/rest";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { logAdminEvent } from "@/lib/admin/logs";
import { auth } from "@/lib/auth";
import {
  githubAgentBranchName,
  githubRepositoryRemoteUrl,
  readGithubDefaultBranch,
} from "@/lib/integrations/github-agent-push-contract";
import {
  GitHubPublicationGitError,
  publishGitHubCandidateBundle,
} from "@/lib/integrations/github-publication-git";
import {
  authorizeGitHubCapability,
  GitHubPolicyError,
} from "@/lib/integrations/github-policy";
import {
  githubToolCredentialMatchesRequest,
  githubToolCredentialRequestSchema,
} from "@/lib/integrations/github-tool-credential-contract";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";

export const runtime = "nodejs";

const headersSchema = z.object({
  resourceId: z.string().uuid(),
  candidateFingerprint: z.string().trim().min(1).max(512),
  candidateCommit: z.string().trim().regex(/^[0-9a-f]{40,64}$/u),
  approvalId: z.string().trim().min(1).max(512).optional(),
});

export async function POST(request: Request) {
  let ticket: EnvironmentToolCredentialTicket | null = null;
  let temporaryRoot: string | null = null;
  try {
    const verifiedTicket = verifyEnvironmentToolCredential({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    ticket = verifiedTicket;
    if (request.headers.get("content-type") !== "application/x-git-bundle") {
      throw new GitHubPolicyError("GITHUB_PUSH_CONTENT_TYPE_INVALID", 415);
    }
    if (!request.body) {
      throw new GitHubPolicyError("GITHUB_PUSH_BUNDLE_REQUIRED", 400);
    }
    const input = headersSchema.parse({
      resourceId: request.headers.get("x-kestrel-resource-id"),
      candidateFingerprint: request.headers.get(
        "x-kestrel-candidate-fingerprint"
      ),
      candidateCommit: request.headers.get("x-kestrel-candidate-commit"),
      approvalId: request.headers.get("x-kestrel-approval-id") ?? undefined,
    });
    const mode = verifiedTicket.operation === "repository.initialize"
      ? "initialize"
      : verifiedTicket.operation === "repository.push_agent_branch"
        ? "agent_branch"
        : null;
    if (!mode) {
      throw new GitHubPolicyError("GITHUB_CREDENTIAL_SCOPE_DENIED");
    }
    const credentialRequest = githubToolCredentialRequestSchema.parse(
      mode === "initialize"
        ? {
            operation: "repository.initialize",
            resourceId: input.resourceId,
            candidateFingerprint: input.candidateFingerprint,
            candidateCommit: input.candidateCommit,
            approvalId: input.approvalId,
            branch: "main",
          }
        : {
            operation: "repository.push_agent_branch",
            resourceId: input.resourceId,
            candidateFingerprint: input.candidateFingerprint,
            candidateCommit: input.candidateCommit,
          },
    );
    if (
      !githubToolCredentialMatchesRequest({
        ticket: verifiedTicket,
        request: credentialRequest,
      })
    ) {
      throw new GitHubPolicyError("GITHUB_CREDENTIAL_SCOPE_DENIED");
    }
    const resource = await knowledgeDb.query.appConnectionResources.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.resourceId),
          eq(table.resourceType, "repository"),
          eq(table.enabled, true)
        ),
    });
    if (!resource) {
      throw new GitHubPolicyError("GITHUB_CONTEXT_DENIED");
    }
    const policy = await authorizeGitHubCapability({
      ticket: verifiedTicket,
      repository: resource.label,
      capability:
        mode === "initialize"
          ? "repository.initialize"
          : "repository.push_agent_branch",
      requireRunExecution: true,
    });
    if (
      (mode === "agent_branch" && policy.approvalMode !== "auto") ||
      (mode === "initialize" && policy.approvalMode !== "ask")
    ) {
      throw new GitHubPolicyError("GITHUB_APPROVAL_REQUIRED", 409);
    }
    const defaultBranch = readGithubDefaultBranch(resource.metadata);
    const branch =
      mode === "initialize"
        ? "main"
        : githubAgentBranchName(verifiedTicket.runId);
    const bundleRef = `refs/kestrel/bundles/${verifiedTicket.runId}`;
    const remoteUrl = githubRepositoryRemoteUrl(resource.label);
    const credential = await auth.api.getAccessToken({
      body: {
        providerId: "github",
        accountId: policy.providerAccountId,
        userId: verifiedTicket.actorId,
      },
    });

    temporaryRoot = await mkdtemp("/tmp/kestrel-github-push-");
    const bundlePath = path.join(temporaryRoot, "candidate.bundle");
    const repositoryPath = path.join(temporaryRoot, "repository.git");
    const askPassPath = path.join(temporaryRoot, "askpass.sh");
    await pipeline(
      Readable.fromWeb(
        request.body as unknown as import("node:stream/web").ReadableStream
      ),
      createWriteStream(bundlePath, { flags: "wx" })
    );
    await writeFile(
      askPassPath,
      '#!/bin/sh\ncase "$1" in *Username*) echo x-access-token ;; *) echo "$KESTREL_GITHUB_TOKEN" ;; esac\n',
      { encoding: "utf8", mode: 0o700 }
    );
    await chmod(askPassPath, 0o700);
    const gitEnvironment = {
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: "0",
      KESTREL_GITHUB_TOKEN: credential.accessToken,
    };
    await publishGitHubCandidateBundle({
      repositoryPath,
      bundlePath,
      bundleRef,
      remoteUrl,
      mode,
      defaultBranch,
      targetBranch: branch,
      expectedCommit: input.candidateCommit,
      gitEnvironment,
    });
    await refreshRepositoryMetadata({
      resource,
      accessToken: credential.accessToken,
      initializationSucceeded: mode === "initialize",
    });
    await logAdminEvent({
      organizationId: verifiedTicket.organizationId,
      actorUserId: verifiedTicket.actorId,
      category: "environment-tools",
      action:
        mode === "initialize"
          ? "github.repository.initialized"
          : "github.repository.push_agent_branch",
      targetType: "environment",
      targetId: verifiedTicket.environmentId,
      message:
        mode === "initialize"
          ? `Initialized ${resource.label}#main from the reviewed candidate.`
          : `Pushed the managed candidate to ${resource.label}#${branch}.`,
      metadata: {
        workspaceId: verifiedTicket.workspaceId,
        threadId: verifiedTicket.threadId,
        runId: verifiedTicket.runId,
        agentId: verifiedTicket.agentId,
        resourceId: resource.id,
        repository: resource.label,
        branch,
        candidateFingerprint: input.candidateFingerprint,
        candidateCommit: input.candidateCommit,
        mode,
        loggingMode: policy.loggingMode,
      },
    });
    return NextResponse.json(
      {
        repository: resource.label,
        branch,
        commit: input.candidateCommit,
        mode,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GitHubPolicyError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status }
      );
    }
    if (error instanceof GitHubPublicationGitError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status },
      );
    }
    return errorResponse(error, ticket ? 400 : 401);
  } finally {
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) {
    throw new Error("A scoped GitHub credential is required.");
  }
  return match[1];
}

async function refreshRepositoryMetadata(input: {
  resource: typeof schema.appConnectionResources.$inferSelect;
  accessToken: string;
  initializationSucceeded: boolean;
}) {
  const [owner, repository] = input.resource.label.split("/");
  let metadata: Record<string, unknown> = {
    ...(input.resource.metadata ?? {}),
    ...(input.initializationSucceeded ? { defaultBranch: "main" } : {}),
  };
  let permissions = input.resource.permissions;
  if (owner && repository) {
    try {
      const response = await new Octokit({ auth: input.accessToken }).rest.repos.get({
        owner,
        repo: repository,
      });
      metadata = {
        ...metadata,
        repositoryId: String(response.data.id),
        defaultBranch: response.data.default_branch,
        isEmpty: false,
        private: response.data.private,
        htmlUrl: response.data.html_url,
      };
      permissions = {
        pull: response.data.permissions?.pull ?? false,
        push: response.data.permissions?.push ?? false,
        admin: response.data.permissions?.admin ?? false,
      };
    } catch {
      // The publication already succeeded. Preserve that fact and let the next
      // explicit repository refresh reconcile the remaining provider metadata.
    }
  }
  await knowledgeDb
    .update(schema.appConnectionResources)
    .set({ metadata, permissions, updatedAt: new Date() })
    .where(eq(schema.appConnectionResources.id, input.resource.id));
}
