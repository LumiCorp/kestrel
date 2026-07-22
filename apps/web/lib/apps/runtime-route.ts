import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { errorResponse } from "@/lib/knowledge/http";
import { enrichUsageEvent, recordUsageEvent } from "@/lib/costs/store";
import { getAppProviderAdapter } from "./provider-adapter";
import { appProviderHealthTransition } from "./provider-health";
import { handleNgrokPreviewLifecycle } from "./ngrok-preview-lifecycle";
import {
  AppRuntimeError,
  authorizeAppRuntime,
  markAppConnectionDegraded,
  markAppConnectionHealthy,
} from "./runtime";

const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;

export async function handleAppRuntimeRequest(input: {
  request: Request;
  appKey: string;
  capabilityKey: string;
  approval: string;
  path: string[];
}) {
  let ticket: EnvironmentExecutionTicket | null = null;
  let connectionId: string | null = null;
  let usageEventId: string | null = null;
  let upstreamStatus: number | null = null;
  try {
    ticket = verifyEnvironmentExecutionTicket({
      token: readBearer(input.request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    if (!ticket.capabilities.includes("kestrel.tools.invoke")) {
      throw new AppRuntimeError("APP_RUNTIME_ROUTE_CAPABILITY_DENIED");
    }
    if (input.approval !== "auto" && input.approval !== "confirmed") {
      throw new AppRuntimeError("APP_RUNTIME_APPROVAL_INVALID", 400);
    }
    if (
      input.path.length < 1 ||
      input.path.length > 2 ||
      input.path.some((part) => !/^[A-Za-z0-9_-]{1,256}$/u.test(part))
    ) {
      throw new AppRuntimeError("APP_RUNTIME_PATH_INVALID", 400);
    }
    const adapter = getAppProviderAdapter(input.appKey);
    const runtime = adapter?.runtime;
    if (
      !(runtime &&runtime.capabilityKeys.includes(input.capabilityKey))
    ) {
      throw new AppRuntimeError("APP_RUNTIME_PROVIDER_NOT_FOUND", 404);
    }
    runtime.assertTarget({
      capability: input.capabilityKey,
      method: input.request.method,
      path: input.path,
    });
    if (new URL(input.request.url).search) {
      throw new AppRuntimeError("APP_RUNTIME_QUERY_DENIED", 400);
    }
    const policy = await authorizeAppRuntime({
      ticket,
      appKey: input.appKey,
      capabilityKey: input.capabilityKey,
      approval: input.approval,
    });
    connectionId = policy.connectionId;
    if (runtime.mode === "lifecycle") {
      if (input.appKey !== "ngrok") {
        throw new AppRuntimeError("APP_RUNTIME_PROVIDER_NOT_FOUND", 404);
      }
      const response = await handleNgrokPreviewLifecycle({
        request: input.request,
        path: input.path,
        capability: input.capabilityKey,
        authorization: input.request.headers.get("authorization") ?? "",
        ticket,
        policy,
      });
      await logAdminEvent({
        organizationId: ticket.organizationId,
        actorUserId: ticket.actorId,
        category: "environment-tools",
        action: `${input.appKey}.${input.capabilityKey}`,
        targetType: "environment",
        targetId: ticket.environmentId,
        message: `Executed ${input.capabilityKey} through ${input.appKey}.`,
        metadata: {
          projectId: policy.projectId,
          workspaceId: ticket.workspaceId,
          threadId: ticket.threadId,
          runId: ticket.runId,
          agentId: ticket.agentId,
          connectionId: policy.connectionId,
          approvalMode: policy.capability.approvalMode,
          loggingMode: policy.capability.loggingMode,
        },
      });
      return response;
    }
    const body =
      input.request.method === "POST"
        ? await readBoundedBody(input.request)
        : undefined;
    const upstreamRequest = runtime.createRequest({
      capability: input.capabilityKey,
      method: input.request.method,
      path: input.path,
      body,
      credential: policy.credential,
    });
    const usageEvent = await recordUsageEvent({
      organizationId: ticket.organizationId,
      actorUserId: ticket.actorId,
      projectId: policy.projectId,
      threadId: ticket.threadId,
      runId: ticket.runId,
      category: "services",
      provider: input.appKey,
      service: input.appKey,
      meter: input.capabilityKey,
      quantity: 1,
      unit: "invocation",
      sourceKind: "app_runtime_invocation",
      sourceId:
        input.request.headers.get("x-kestrel-request-id")?.trim() ||
        input.request.headers.get("x-request-id")?.trim() ||
        crypto.randomUUID(),
      occurredAt: new Date(),
      metadata: {
        connectionId: policy.connectionId,
        approvalMode: policy.capability.approvalMode,
      },
    });
    usageEventId = usageEvent.id;
    const upstream = await fetch(upstreamRequest.url, {
      ...upstreamRequest.init,
      signal:
        upstreamRequest.timeoutMs === undefined
          ? input.request.signal
          : AbortSignal.any([
              input.request.signal,
              AbortSignal.timeout(upstreamRequest.timeoutMs),
            ]),
    });
    upstreamStatus = upstream.status;
    const healthTransition = appProviderHealthTransition({
      status: upstream.status,
      degradedStatusCodes: runtime.degradedStatusCodes,
    });
    await enrichUsageEvent(usageEventId, {
      outcome: upstream.ok ? "succeeded" : "provider_error",
      upstreamStatus: upstream.status,
    }).catch((error) => {
      console.error("[costs] App usage outcome enrichment failed.", {
        message: error instanceof Error ? error.message : "Unknown error",
        usageEventId,
      });
    });
    if (policy.connectionId && healthTransition === "degraded") {
      await markAppConnectionDegraded({
        organizationId: ticket.organizationId,
        environmentId: ticket.environmentId,
        appKey: input.appKey,
        connectionId: policy.connectionId,
        failureCode: runtime.reconnectFailureCode,
      });
    } else if (policy.connectionId && healthTransition === "healthy") {
      await markAppConnectionHealthy({
        organizationId: ticket.organizationId,
        environmentId: ticket.environmentId,
        appKey: input.appKey,
        connectionId: policy.connectionId,
      });
    }
    await logAdminEvent({
      organizationId: ticket.organizationId,
      actorUserId: ticket.actorId,
      category: "environment-tools",
      action: `${input.appKey}.${input.capabilityKey}`,
      targetType: "environment",
      targetId: ticket.environmentId,
      message: `Executed ${input.capabilityKey} through ${input.appKey}.`,
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
        usageEventId,
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
    if (usageEventId) {
      await enrichUsageEvent(usageEventId, {
        outcome:
          upstreamStatus == null
            ? "failed"
            : upstreamStatus >= 200 && upstreamStatus < 300
              ? "succeeded"
              : "provider_error",
        ...(upstreamStatus == null
          ? {
              errorCode:
                error instanceof AppRuntimeError
                  ? error.code
                  : isRuntimeContractError(error)
                    ? error.code
                    : error instanceof DOMException
                      ? "APP_RUNTIME_PROVIDER_TIMEOUT"
                      : "APP_RUNTIME_PROVIDER_FAILED",
            }
          : { upstreamStatus }),
      }).catch(() => {});
    }
    if (error instanceof AppRuntimeError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status }
      );
    }
    if (isRuntimeContractError(error)) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status }
      );
    }
    if (ticket && connectionId && error instanceof DOMException) {
      return NextResponse.json(
        { error: { code: "APP_RUNTIME_PROVIDER_TIMEOUT" } },
        { status: 504 }
      );
    }
    return errorResponse(error, ticket ? 400 : 401);
  }
}

async function readBoundedBody(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BODY_BYTES) {
    throw new AppRuntimeError("APP_RUNTIME_BODY_TOO_LARGE", 413);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_PROXY_BODY_BYTES) {
    throw new AppRuntimeError("APP_RUNTIME_BODY_TOO_LARGE", 413);
  }
  return body;
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) throw new Error("Environment execution ticket is required.");
  return match[1];
}

function isRuntimeContractError(
  error: unknown
): error is { code: string; status: number } {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      "status" in error &&
      typeof error.status === "number"
  );
}
