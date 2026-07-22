import "server-only";

import { and, eq } from "drizzle-orm";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
} from "@/lib/ai/gateway-credential-crypto";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { FlyMachinesClient } from "./providers/fly-machines";

const connectionIdFor = (organizationId: string) =>
  `organization-fly:${organizationId}`;

type FlyMetadata = { organizationSlug?: string };

export async function getFlyProviderConnection(organizationId: string) {
  return knowledgeDb.query.aiProviderConnections.findFirst({
    where: and(
      eq(schema.aiProviderConnections.organizationId, organizationId),
      eq(schema.aiProviderConnections.provider, "fly")
    ),
  });
}

export async function listEnabledFlyProviderConnections() {
  return knowledgeDb.query.aiProviderConnections.findMany({
    where: and(
      eq(schema.aiProviderConnections.provider, "fly"),
      eq(schema.aiProviderConnections.enabled, true)
    ),
  });
}

export function sanitizeFlyProviderConnection(
  connection: typeof schema.aiProviderConnections.$inferSelect | undefined
) {
  const metadata = (connection?.metadata ?? {}) as FlyMetadata;
  return connection
    ? {
        id: connection.id,
        provider: connection.provider,
        displayName: connection.displayName,
        enabled: connection.enabled,
        status: connection.status,
        hasApiToken: Boolean(connection.apiKey?.trim()),
        organizationSlug: metadata.organizationSlug ?? "",
        lastTestedAt: connection.lastTestedAt,
      }
    : null;
}

export async function configureFlyProviderConnection(input: {
  organizationId: string;
  apiToken?: string | null;
  organizationSlug: string;
  enabled?: boolean;
}) {
  const organizationSlug = input.organizationSlug.trim();
  if (!organizationSlug) throw new Error("Fly organization slug is required.");
  const existing = await getFlyProviderConnection(input.organizationId);
  const apiToken = input.apiToken?.trim() || null;
  const encryptedToken = apiToken
    ? encryptGatewayCredential({
        gatewayId: connectionIdFor(input.organizationId),
        plaintext: apiToken,
      })
    : (existing?.apiKey ?? null);
  if (!encryptedToken) throw new Error("Fly API token is required.");
  const values = {
    organizationId: input.organizationId,
    provider: "fly" as const,
    scope: "organization" as const,
    displayName: "Fly.io",
    apiKey: encryptedToken,
    apiKeyEnvVar: null,
    enabled: input.enabled ?? existing?.enabled ?? true,
    status: "not_configured" as const,
    metadata: { organizationSlug },
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
  return sanitizeFlyProviderConnection(connection);
}

export function createFlyProviderClientFromConnection(
  connection: typeof schema.aiProviderConnections.$inferSelect
) {
  if (!connection.enabled) throw new Error("Fly provider connection is disabled.");
  const metadata = (connection.metadata ?? {}) as FlyMetadata;
  const organizationSlug = metadata.organizationSlug?.trim();
  if (!(connection.apiKey?.trim() && organizationSlug)) {
    throw new Error("Fly provider connection is incomplete.");
  }
  return new FlyMachinesClient({
    token: decryptGatewayCredential({
      gatewayId: connection.id,
      encrypted: connection.apiKey.trim(),
    }),
    organizationSlug,
  });
}

export async function createFlyProviderClient(organizationId: string) {
  const connection = await getFlyProviderConnection(organizationId);
  if (!connection) throw new Error("Fly provider connection is not configured.");
  return createFlyProviderClientFromConnection(connection);
}

export async function testFlyProviderConnection(organizationId: string) {
  const connection = await getFlyProviderConnection(organizationId);
  if (!connection) throw new Error("Fly provider connection is not configured.");
  try {
    await createFlyProviderClientFromConnection(connection).testConnection();
    const [updated] = await knowledgeDb
      .update(schema.aiProviderConnections)
      .set({ status: "ready", lastTestedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.aiProviderConnections.id, connection.id))
      .returning();
    return sanitizeFlyProviderConnection(updated);
  } catch (error) {
    await knowledgeDb
      .update(schema.aiProviderConnections)
      .set({ status: "degraded", lastTestedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.aiProviderConnections.id, connection.id));
    throw error;
  }
}
