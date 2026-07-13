import "server-only";

import { eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
} from "./gateway-credential-crypto";
import {
  type RunPodControlFetch,
  RunPodControlPlaneClient,
} from "./runpod-control-plane";

const RUNPOD_CONNECTION_ID = "platform-runpod";
const RUNPOD_ENV_VAR = "RUNPOD_API_KEY";

export async function getRunPodProviderConnection() {
  return knowledgeDb.query.aiProviderConnections.findFirst({
    where: eq(schema.aiProviderConnections.provider, "runpod"),
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
        apiKeyEnvVar: connection.apiKeyEnvVar,
        hasApiKey: Boolean(connection.apiKey?.trim()),
        lastTestedAt: connection.lastTestedAt,
        metadata: connection.metadata,
      }
    : null;
}

export async function configureRunPodProviderConnection(input: {
  apiKey?: string | null;
  useEnvironment?: boolean;
  enabled?: boolean;
}) {
  const apiKey = input.apiKey?.trim() || null;
  const existing = await getRunPodProviderConnection();
  const encryptedApiKey = apiKey
    ? encryptGatewayCredential({
        gatewayId: RUNPOD_CONNECTION_ID,
        plaintext: apiKey,
      })
    : input.useEnvironment
      ? null
      : (existing?.apiKey ?? null);
  const [connection] = await knowledgeDb
    .insert(schema.aiProviderConnections)
    .values({
      id: RUNPOD_CONNECTION_ID,
      provider: "runpod",
      scope: "platform",
      displayName: "RunPod Platform",
      apiKey: encryptedApiKey,
      apiKeyEnvVar: input.useEnvironment ? RUNPOD_ENV_VAR : null,
      enabled: input.enabled ?? existing?.enabled ?? true,
      status: "not_configured",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.aiProviderConnections.provider,
        schema.aiProviderConnections.scope,
      ],
      set: {
        apiKey: encryptedApiKey,
        apiKeyEnvVar: input.useEnvironment ? RUNPOD_ENV_VAR : null,
        enabled: input.enabled ?? existing?.enabled ?? true,
        status: "not_configured",
        updatedAt: new Date(),
      },
    })
    .returning();
  if (connection && (apiKey || input.useEnvironment)) {
    const managedGateways = await knowledgeDb.query.aiGateways.findMany({
      where: eq(schema.aiGateways.providerConnectionId, connection.id),
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
          apiKeyEnvVar: input.useEnvironment ? RUNPOD_ENV_VAR : null,
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
  const envVar = connection.apiKeyEnvVar?.trim();
  const apiKey = envVar ? process.env[envVar]?.trim() : null;
  if (!apiKey) {
    throw new Error("RunPod provider connection credential is missing.");
  }
  return apiKey;
}

export async function createRunPodControlPlaneClient(input?: {
  fetchImpl?: RunPodControlFetch;
}) {
  const connection = await getRunPodProviderConnection();
  if (!connection) {
    throw new Error("RunPod provider connection is not configured.");
  }
  return {
    connection,
    client: new RunPodControlPlaneClient({
      apiKey: resolveRunPodProviderApiKey(connection),
      ...(input?.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    }),
  };
}

export async function testRunPodProviderConnection(input?: {
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
