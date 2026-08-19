import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import { knowledgeDb } from "@/lib/knowledge/db";

export async function refreshEnvironmentGateway(input: {
  organizationId: string;
  environmentId: string;
  expectedRouteGeneration?: string | undefined;
}) {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq }) => and(
      eq(table.id, input.environmentId),
      eq(table.organizationId, input.organizationId)
    ),
    columns: { routerUrl: true },
  });
  if (!environment?.routerUrl) {
    throw new Error("Environment gateway is unavailable.");
  }
  const now = Math.floor(Date.now() / 1000);
  const token = signEnvironmentToolCredential({
    privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
    ticket: {
      version: ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
      audience: ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: "environment-gateway",
      threadId: "environment-gateway",
      runId: crypto.randomUUID(),
      actorId: "kestrel-control-plane",
      agentId: "kestrel-control-plane",
      providerKey: "kestrel-control-plane",
      resourceId: input.environmentId,
      capability: "gateway.config.refresh",
      operation: "refresh",
      operationBinding: null,
      issuedAt: now,
      expiresAt: now + 60,
      nonce: crypto.randomUUID(),
    },
  });
  const response = await fetch(
    new URL("/internal/config/refresh", environment.routerUrl),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!response.ok) {
    throw new Error(`Environment gateway refresh failed (${response.status}).`);
  }
  const result = await response.json().catch(() => null) as unknown;
  if (
    input.expectedRouteGeneration !== undefined &&
    (!isRecord(result) || result.ok !== true)
  ) {
    throw new Error("Environment gateway refresh returned an invalid acknowledgement.");
  }
  const routeGeneration = isRecord(result) && typeof result.routeGeneration === "string"
    ? result.routeGeneration
    : null;
  if (
    input.expectedRouteGeneration !== undefined &&
    routeGeneration !== input.expectedRouteGeneration
  ) {
    throw new Error("Environment gateway acknowledged an unexpected route generation.");
  }
  return {
    revision: isRecord(result) && typeof result.revision === "string" ? result.revision : null,
    gatewayId: isRecord(result) && typeof result.gatewayId === "string" ? result.gatewayId : null,
    routeGeneration,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
