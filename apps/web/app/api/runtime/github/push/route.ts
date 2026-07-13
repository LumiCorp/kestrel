import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type EnvironmentToolCredentialTicket,
  verifyEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { auth } from "@/lib/auth";
import {
  githubAgentBranchName,
  githubRepositoryRemoteUrl,
  readGithubDefaultBranch,
} from "@/lib/integrations/github-agent-push-contract";
import {
  authorizeGitHubCapability,
  GitHubPolicyError,
} from "@/lib/integrations/github-policy";
import {
  githubToolCredentialMatchesRequest,
  githubToolCredentialRequestSchema,
} from "@/lib/integrations/github-tool-credential-contract";
import { knowledgeDb } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";

export const runtime = "nodejs";

const headersSchema = z.object({
  resourceId: z.string().uuid(),
  candidateFingerprint: z.string().trim().min(1).max(512),
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
    });
    const credentialRequest = githubToolCredentialRequestSchema.parse({
      operation: "repository.push_agent_branch",
      resourceId: input.resourceId,
      candidateFingerprint: input.candidateFingerprint,
    });
    if (
      !githubToolCredentialMatchesRequest({
        ticket: verifiedTicket,
        request: credentialRequest,
      })
    ) {
      throw new GitHubPolicyError("GITHUB_CREDENTIAL_SCOPE_DENIED");
    }
    const resource = await knowledgeDb.query.toolConnectionResources.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.resourceId),
          eq(table.organizationId, verifiedTicket.organizationId),
          eq(table.providerKey, "github"),
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
      capability: "repository.push_agent_branch",
      requireRunExecution: true,
    });
    if (policy.approvalMode !== "auto") {
      throw new GitHubPolicyError("GITHUB_APPROVAL_REQUIRED", 409);
    }
    const defaultBranch = readGithubDefaultBranch(resource.metadata);
    if (!defaultBranch) {
      throw new GitHubPolicyError("GITHUB_DEFAULT_BRANCH_UNAVAILABLE", 409);
    }
    const branch = githubAgentBranchName(verifiedTicket.runId);
    const bundleRef = `refs/kestrel/bundles/${verifiedTicket.runId}`;
    const remoteUrl = githubRepositoryRemoteUrl(resource.label);
    const credential = await auth.api.getAccessToken({
      body: {
        providerId: "github",
        accountId: policy.connection.providerAccountId,
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
    await runGit(["init", "--bare", repositoryPath], temporaryRoot, {});
    await runGit(
      [
        "-C",
        repositoryPath,
        "fetch",
        "--no-tags",
        remoteUrl,
        `refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
      ],
      temporaryRoot,
      gitEnvironment
    );
    await runGit(
      ["-C", repositoryPath, "bundle", "verify", bundlePath],
      temporaryRoot,
      {}
    );
    await runGit(
      ["-C", repositoryPath, "fetch", bundlePath, bundleRef],
      temporaryRoot,
      {}
    );
    await runGit(
      [
        "-C",
        repositoryPath,
        "push",
        "--force",
        remoteUrl,
        `FETCH_HEAD:refs/heads/${branch}`,
      ],
      temporaryRoot,
      gitEnvironment
    );
    await logAdminEvent({
      organizationId: verifiedTicket.organizationId,
      actorUserId: verifiedTicket.actorId,
      category: "environment-tools",
      action: "github.repository.push_agent_branch",
      targetType: "environment",
      targetId: verifiedTicket.environmentId,
      message: `Pushed the managed candidate to ${resource.label}#${branch}.`,
      metadata: {
        workspaceId: verifiedTicket.workspaceId,
        threadId: verifiedTicket.threadId,
        runId: verifiedTicket.runId,
        agentId: verifiedTicket.agentId,
        resourceId: resource.id,
        repository: resource.label,
        branch,
        candidateFingerprint: input.candidateFingerprint,
        loggingMode: policy.loggingMode,
      },
    });
    return NextResponse.json(
      { repository: resource.label, branch },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GitHubPolicyError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status }
      );
    }
    return errorResponse(error, ticket ? 400 : 401);
  } finally {
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function runGit(
  args: string[],
  cwd: string,
  extraEnvironment: Record<string, string>
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...extraEnvironment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new GitHubPolicyError("GITHUB_PUSH_GIT_FAILED", 502));
    });
  });
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) {
    throw new Error("A scoped GitHub credential is required.");
  }
  return match[1];
}
