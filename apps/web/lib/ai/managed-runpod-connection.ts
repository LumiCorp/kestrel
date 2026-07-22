import "server-only";

import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
} from "./gateway-credential-crypto";
import {
  type RunPodControlFetch,
  RunPodControlPlaneClient,
} from "./runpod-control-plane";

const connectionIdFor = (organizationId: string) =>
  `organization-runpod:${organizationId}`;

export async function getRunPodProviderConnection(organizationId: string) {
  return knowledgeDb.query.aiProviderConnections.findFirst({
    where: and(
      eq(schema.aiProviderConnections.organizationId, organizationId),
      eq(schema.aiProviderConnections.provider, "runpod")
    ),
  });
}

export async function listEnabledRunPodProviderConnections() {
  return knowledgeDb.query.aiProviderConnections.findMany({
    where: and(
      eq(schema.aiProviderConnections.provider, "runpod"),
      eq(schema.aiProviderConnections.enabled, true)
    ),
  });
}

export function sanitizeRunPodProviderConnection(
  connection: typeof schema.aiProviderConnections.$inferSelect | undefined
) {
  return connection
    ? {
        id: connection.id,
        provider: connection.provider,
        displayName: connection.displayName,
        enabled: connection.enabled,
        status: connection.status,
        hasApiKey: Boolean(connection.apiKey?.trim()),
        lastTestedAt: connection.lastTestedAt,
        metadata: connection.metadata,
      }
    : null;
}

export async function configureRunPodProviderConnection(input: {
  organizationId: string;
  apiKey?: string | null;
  enabled?: boolean;
}) {
  const apiKey = input.apiKey?.trim() || null;
  const existing = await getRunPodProviderConnection(input.organizationId);
  const encryptedApiKey = apiKey
    ? encryptGatewayCredential({
        gatewayId: connectionIdFor(input.organizationId),
        plaintext: apiKey,
      })
    : (existing?.apiKey ?? null);
  if (!encryptedApiKey) {
    throw new Error("RunPod provider connection credential is required.");
  }
  const values = {
    organizationId: input.organizationId,
    provider: "runpod" as const,
    scope: "organization" as const,
    displayName: "RunPod",
    apiKey: encryptedApiKey,
    apiKeyEnvVar: null,
    enabled: input.enabled ?? existing?.enabled ?? true,
    status: "not_configured" as const,
    updatedAt: new Date(),
  };
  const [connection] = existing
    ? await knowledgeDb
        .update(schema.aiProviderConnections)
        .set(values)
        .where(eq(schema.aiProviderConnections.id, existing.id))
        .returning()
    : await knowledgeDb
        .insert(schema.aiProviderConnections)
        .values({ id: connectionIdFor(input.organizationId), ...values })
        .returning();
  if (connection && apiKey) {
    const managedGateways = await knowledgeDb.query.aiGateways.findMany({
      where: and(
        eq(schema.aiGateways.organizationId, input.organizationId),
        eq(schema.aiGateways.providerConnectionId, connection.id)
      ),
      columns: { id: true },
    });
    for (const gateway of managedGateways) {
      await knowledgeDb
        .update(schema.aiGateways)
        .set({
          apiKey: apiKey
            ? encryptGatewayCredential({
                gatewayId: gateway.id,
                plaintext: apiKey,
              })
            : null,
          apiKeyEnvVar: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.aiGateways.id, gateway.id));
    }
  }
  return sanitizeRunPodProviderConnection(connection);
}

export function resolveRunPodProviderApiKey(
  connection: typeof schema.aiProviderConnections.$inferSelect
) {
  if (!connection.enabled) {
    throw new Error("RunPod provider connection is disabled.");
  }
  if (connection.apiKey?.trim()) {
    return decryptGatewayCredential({
      gatewayId: connection.id,
      encrypted: connection.apiKey.trim(),
    });
  }
  throw new Error("RunPod provider connection credential is missing.");
}

export async function createRunPodControlPlaneClient(input: {
  organizationId: string;
  fetchImpl?: RunPodControlFetch;
}) {
  const connection = await getRunPodProviderConnection(input.organizationId);
  if (!connection) {
    throw new Error("RunPod provider connection is not configured.");
  }
  return {
    connection,
    client: new RunPodControlPlaneClient({
      apiKey: resolveRunPodProviderApiKey(connection),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    }),
  };
}

export async function testRunPodProviderConnection(input: {
  organizationId: string;
  fetchImpl?: RunPodControlFetch;
}) {
  const { connection, client } = await createRunPodControlPlaneClient(input);
  try {
    await client.testConnection();
    const [updated] = await knowledgeDb
      .update(schema.aiProviderConnections)
      .set({ status: "ready", lastTestedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.aiProviderConnections.id, connection.id))
      .returning();
    return sanitizeRunPodProviderConnection(updated);
  } catch (error) {
    await knowledgeDb
      .update(schema.aiProviderConnections)
      .set({
        status: "degraded",
        lastTestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.aiProviderConnections.id, connection.id));
    throw error;
  }
}
