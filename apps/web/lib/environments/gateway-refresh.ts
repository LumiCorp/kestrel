import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import { knowledgeDb } from "@/lib/knowledge/db";

export async function refreshEnvironmentGateway(input: {
  organizationId: string;
  environmentId: string;
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
    }
  );
  if (!response.ok) {
    throw new Error(`Environment gateway refresh failed (${response.status}).`);
  }
}
