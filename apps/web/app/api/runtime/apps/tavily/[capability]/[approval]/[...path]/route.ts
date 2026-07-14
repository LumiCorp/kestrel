import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  assertTavilyProxyTarget,
  authorizeTavilyRuntime,
  markTavilyConnectionDegraded,
  TAVILY_RUNTIME_CAPABILITIES,
  TavilyRuntimeError,
} from "@/lib/apps/tavily-runtime";
import { errorResponse } from "@/lib/knowledge/http";

const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";

const paramsSchema = z.object({
  capability: z.enum(TAVILY_RUNTIME_CAPABILITIES),
  approval: z.enum(["auto", "confirmed"]),
  path: z.array(z.string().min(1).max(256)).min(1).max(2),
});

async function handle(
  request: Request,
  context: {
    params: Promise<{
      capability: string;
      approval: string;
      path: string[];
    }>;
  }
) {
  let ticket: EnvironmentExecutionTicket | null = null;
  let connectionId: string | null = null;
  try {
    ticket = verifyEnvironmentExecutionTicket({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    if (!ticket.capabilities.includes("kestrel.tools.invoke")) {
      throw new TavilyRuntimeError("TAVILY_ROUTE_CAPABILITY_DENIED");
    }
    const params = paramsSchema.parse(await context.params);
    assertTavilyProxyTarget({
      capability: params.capability,
      method: request.method,
      path: params.path,
    });
    if (new URL(request.url).search) {
      throw new TavilyRuntimeError("TAVILY_PROXY_QUERY_DENIED", 400);
    }
    const policy = await authorizeTavilyRuntime({
      ticket,
      capability: params.capability,
      approval: params.approval,
    });
    connectionId = policy.connectionId;
    const body =
      request.method === "POST" ? await readBoundedBody(request) : undefined;
    const upstreamUrl = new URL(
      params.path.map(encodeURIComponent).join("/"),
      ensureTrailingSlash(policy.credential.baseUrl ?? DEFAULT_TAVILY_BASE_URL)
    );
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${policy.credential.apiKey}`,
        ...(request.method === "POST"
          ? { "content-type": "application/json" }
          : {}),
        "X-Client-Source": "kestrel-one",
        ...(policy.credential.projectId
          ? { "X-Project-ID": policy.credential.projectId }
          : {}),
      },
      ...(body ? { body } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
    if (upstream.status === 401 || upstream.status === 403) {
      await markTavilyConnectionDegraded({
        organizationId: ticket.organizationId,
        environmentId: ticket.environmentId,
        connectionId: policy.connectionId,
        failureCode: "TAVILY_RECONNECT_REQUIRED",
      });
    }
    await logAdminEvent({
      organizationId: ticket.organizationId,
      actorUserId: ticket.actorId,
      category: "environment-tools",
      action: `tavily.${params.capability}`,
      targetType: "environment",
      targetId: ticket.environmentId,
      message: `Executed ${params.capability} through Tavily.`,
      metadata: {
        projectId: policy.projectId,
        workspaceId: ticket.workspaceId,
        threadId: ticket.threadId,
        runId: ticket.runId,
        agentId: ticket.agentId,
        connectionId: policy.connectionId,
        approvalMode: policy.capability.approvalMode,
        loggingMode: policy.capability.loggingMode,
        upstreamStatus: upstream.status,
      },
    });
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        "cache-control": "no-store",
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    if (error instanceof TavilyRuntimeError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status }
      );
    }
    if (ticket && connectionId && error instanceof DOMException) {
      return NextResponse.json(
        { error: { code: "TAVILY_PROVIDER_TIMEOUT" } },
        { status: 504 }
      );
    }
    return errorResponse(error, ticket ? 400 : 401);
  }
}

async function readBoundedBody(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BODY_BYTES) {
    throw new TavilyRuntimeError("TAVILY_PROXY_BODY_TOO_LARGE", 413);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_PROXY_BODY_BYTES) {
    throw new TavilyRuntimeError("TAVILY_PROXY_BODY_TOO_LARGE", 413);
  }
  return body;
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) throw new Error("Environment execution ticket is required.");
  return match[1];
}

export const GET = handle;
export const POST = handle;
