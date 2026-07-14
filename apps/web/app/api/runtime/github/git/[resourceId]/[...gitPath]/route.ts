import {
  type EnvironmentToolCredentialTicket,
  verifyEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { auth } from "@/lib/auth";
import {
  githubRepositoryUpstreamUrl,
  isGitUploadPackRequest,
} from "@/lib/integrations/github-git-proxy-contract";
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

type RouteContext = {
  params: Promise<{ resourceId: string; gitPath: string[] }>;
};

export async function GET(request: Request, context: RouteContext) {
  return proxyGitUploadPack(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return proxyGitUploadPack(request, context);
}

async function proxyGitUploadPack(request: Request, context: RouteContext) {
  let ticket: EnvironmentToolCredentialTicket | null = null;
  try {
    const verifiedTicket = verifyEnvironmentToolCredential({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    ticket = verifiedTicket;
    const { resourceId, gitPath } = await context.params;
    const credentialRequest = githubToolCredentialRequestSchema.parse({
      operation: "git.upload_pack",
      resourceId,
    });
    if (
      !githubToolCredentialMatchesRequest({
        ticket: verifiedTicket,
        request: credentialRequest,
      })
    ) {
      throw new GitHubPolicyError("GITHUB_CREDENTIAL_SCOPE_DENIED");
    }
    const url = new URL(request.url);
    assertGitUploadPackRequest(request.method, gitPath, url.searchParams);
    const resource = await knowledgeDb.query.toolConnectionResources.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, resourceId),
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
      capability: "repository.read",
    });
    if (policy.approvalMode !== "auto") {
      throw new GitHubPolicyError("GITHUB_APPROVAL_REQUIRED", 409);
    }
    const credential = await auth.api.getAccessToken({
      body: {
        providerId: "github",
        accountId: policy.connection.providerAccountId,
        userId: verifiedTicket.actorId,
      },
    });
    const upstreamUrl = githubRepositoryUpstreamUrl({
      repository: resource.label,
      path: gitPath,
      search: request.method === "GET" ? url.search : "",
    });
    const upstreamHeaders = new Headers({
      accept: request.headers.get("accept") ?? "*/*",
      authorization: `Bearer ${credential.accessToken}`,
      "user-agent": "Kestrel-One-Git-Proxy",
    });
    const contentType = request.headers.get("content-type");
    if (contentType) upstreamHeaders.set("content-type", contentType);
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: upstreamHeaders,
      cache: "no-store",
      redirect: "manual",
    };
    if (request.method === "POST") {
      init.body = request.body;
      init.duplex = "half";
    }
    const upstream = await fetch(upstreamUrl, init);
    if (request.method === "POST") {
      await logAdminEvent({
        organizationId: verifiedTicket.organizationId,
        actorUserId: verifiedTicket.actorId,
        category: "environment-tools",
        action: "github.repository.read",
        targetType: "environment",
        targetId: verifiedTicket.environmentId,
        message: `Proxied a Git repository read for ${resource.label}.`,
        metadata: {
          workspaceId: verifiedTicket.workspaceId,
          threadId: verifiedTicket.threadId,
          runId: verifiedTicket.runId,
          agentId: verifiedTicket.agentId,
          resourceId: resource.id,
          repository: resource.label,
          loggingMode: policy.loggingMode,
        },
      });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthroughHeaders(upstream.headers),
    });
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
          message: "Denied a Git repository read by Environment policy.",
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
    return errorResponse(error, 401);
  }
}

function assertGitUploadPackRequest(
  method: string,
  path: string[],
  searchParams: URLSearchParams
) {
  if (
    !isGitUploadPackRequest({
      method,
      path,
      service: searchParams.get("service"),
    })
  ) {
    throw new GitHubPolicyError("GITHUB_GIT_OPERATION_DENIED", 404);
  }
}

function passthroughHeaders(headers: Headers) {
  const output = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "content-length"]) {
    const value = headers.get(name);
    if (value) output.set(name, value);
  }
  return output;
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) {
    throw new Error("A scoped GitHub credential is required.");
  }
  return match[1];
}
