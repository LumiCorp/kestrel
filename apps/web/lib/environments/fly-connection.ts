import "server-only";

import { and, eq } from "drizzle-orm";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
} from "@/lib/ai/gateway-credential-crypto";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { FlyMachinesClient } from "./providers/fly-machines";
import { FlyEnvironmentInfrastructureProviderV2 } from "./providers/fly-v2";
import { EnvironmentInfrastructureProviderV2LegacyAdapter } from "./providers/v2-legacy-adapter";
import {
  flyEnvironmentProviderConnectionId,
  mirrorFlyProviderConnectionInTransaction,
} from "./provider-persistence";
import { parseEnvironmentProviderConnectionConfiguration } from "./provider-persistence-contracts";

const connectionIdFor = (organizationId: string) =>
  flyEnvironmentProviderConnectionId(organizationId);

type FlyMetadata = { organizationSlug?: string };
export type FlyProviderAuthority = {
  token: string;
  organizationSlug: string;
};

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
  return knowledgeDb.transaction(async (transaction) => {
    const existing =
      await transaction.query.aiProviderConnections.findFirst({
        where: and(
          eq(
            schema.aiProviderConnections.organizationId,
            input.organizationId,
          ),
          eq(schema.aiProviderConnections.provider, "fly"),
        ),
      });
    const apiToken = input.apiToken?.trim() || null;
    const encryptedToken = apiToken
      ? encryptGatewayCredential({
          gatewayId: connectionIdFor(input.organizationId),
          plaintext: apiToken,
        })
      : (existing?.apiKey ?? null);
    if (!encryptedToken) throw new Error("Fly API token is required.");
    const now = new Date();
    const enabled = input.enabled ?? existing?.enabled ?? true;
    const values = {
      organizationId: input.organizationId,
      provider: "fly" as const,
      scope: "organization" as const,
      displayName: "Fly.io",
      apiKey: encryptedToken,
      apiKeyEnvVar: null,
      enabled,
      status: "not_configured" as const,
      metadata: { organizationSlug },
      updatedAt: now,
    };
    const [connection] = existing
      ? await transaction
          .update(schema.aiProviderConnections)
          .set(values)
          .where(eq(schema.aiProviderConnections.id, existing.id))
          .returning()
      : await transaction
          .insert(schema.aiProviderConnections)
          .values({ id: connectionIdFor(input.organizationId), ...values })
          .returning();
    if (!connection) throw new Error("Fly provider connection update failed.");
    await mirrorFlyProviderConnectionInTransaction(transaction, {
      organizationId: input.organizationId,
      organizationSlug,
      encryptedCredential: encryptedToken,
      enabled,
      status: "not_configured",
      now,
    });
    return sanitizeFlyProviderConnection(connection);
  });
}

export function createFlyProviderClientFromConnection(
  connection: typeof schema.aiProviderConnections.$inferSelect,
  options: { fetchImpl?: typeof fetch } = {}
) {
  const authority = resolveFlyProviderAuthorityFromConnection(connection);
  return new FlyMachinesClient({
    ...authority,
    fetchImpl: options.fetchImpl,
  });
}

function resolveFlyProviderAuthorityFromConnection(
  connection: typeof schema.aiProviderConnections.$inferSelect
): FlyProviderAuthority {
  if (!connection.enabled) {
    throw new Error("Fly provider connection is disabled.");
  }
  const metadata = (connection.metadata ?? {}) as FlyMetadata;
  const organizationSlug = metadata.organizationSlug?.trim();
  if (!(connection.apiKey?.trim() && organizationSlug)) {
    throw new Error("Fly provider connection is incomplete.");
  }
  return {
    token: decryptGatewayCredential({
      gatewayId: connection.id,
      encrypted: connection.apiKey.trim(),
    }),
    organizationSlug,
  };
}

export async function resolveFlyProviderAuthority(
  organizationId: string
): Promise<FlyProviderAuthority> {
  const neutral =
    await knowledgeDb.query.environmentProviderConnections.findFirst({
      where: and(
        eq(
          schema.environmentProviderConnections.id,
          connectionIdFor(organizationId),
        ),
        eq(
          schema.environmentProviderConnections.organizationId,
          organizationId,
        ),
        eq(schema.environmentProviderConnections.provider, "fly"),
      ),
    });
  if (neutral) return resolveFlyProviderAuthorityFromNeutralConnection(neutral);
  const connection = await getFlyProviderConnection(organizationId);
  if (connection) return resolveFlyProviderAuthorityFromConnection(connection);
  throw new Error("Fly provider connection is not configured.");
}

function resolveFlyProviderAuthorityFromNeutralConnection(
  connection: typeof schema.environmentProviderConnections.$inferSelect,
): FlyProviderAuthority {
  if (connection.status === "revoked" || connection.revokedAt) {
    throw new Error("Fly provider connection is revoked.");
  }
  const configuration = parseEnvironmentProviderConnectionConfiguration(
    connection.configuration,
  );
  if (configuration.contract !== "fly-connection-configuration-v1") {
    throw new Error("Fly provider connection configuration is invalid.");
  }
  const organizationSlug = configuration.organizationSlug?.trim();
  if (!(connection.encryptedCredential?.trim() && organizationSlug)) {
    throw new Error("Fly provider connection is incomplete.");
  }
  return {
    token: decryptGatewayCredential({
      gatewayId: connection.id,
      encrypted: connection.encryptedCredential.trim(),
    }),
    organizationSlug,
  };
}

export async function createFlyProviderClientForNeutralConnection(input: {
  organizationId: string;
  connectionId: string;
  fetchImpl?: typeof fetch | undefined;
}) {
  const connection =
    await knowledgeDb.query.environmentProviderConnections.findFirst({
      where: and(
        eq(schema.environmentProviderConnections.id, input.connectionId),
        eq(
          schema.environmentProviderConnections.organizationId,
          input.organizationId,
        ),
        eq(schema.environmentProviderConnections.provider, "fly"),
      ),
    });
  if (!connection) throw new Error("Fly provider connection is not configured.");
  return new FlyMachinesClient({
    ...resolveFlyProviderAuthorityFromNeutralConnection(connection),
    fetchImpl: input.fetchImpl,
  });
}

export async function createFlyProviderClient(organizationId: string) {
  return new FlyMachinesClient(await resolveFlyProviderAuthority(organizationId));
}

export async function createFlyProviderLifecycleAdapter(
  organizationId: string,
  environmentId: string,
) {
  const client = await createFlyProviderClient(organizationId);
  return new EnvironmentInfrastructureProviderV2LegacyAdapter(
    new FlyEnvironmentInfrastructureProviderV2(client),
    {
      connectionId: connectionIdFor(organizationId),
      provider: "fly",
      organizationId,
      environmentId,
    },
  );
}

export async function testFlyProviderConnection(
  organizationId: string,
  options: { fetchImpl?: typeof fetch } = {}
) {
  const connection = await getFlyProviderConnection(organizationId);
  if (!connection) throw new Error("Fly provider connection is not configured.");
  try {
    await createFlyProviderClientFromConnection(
      connection,
      options
    ).testConnection();
    const updated = await knowledgeDb.transaction(async (transaction) => {
      const now = new Date();
      const [legacy] = await transaction
        .update(schema.aiProviderConnections)
        .set({ status: "ready", lastTestedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.aiProviderConnections.id, connection.id),
            eq(schema.aiProviderConnections.updatedAt, connection.updatedAt),
          ),
        )
        .returning();
      if (!legacy) return null;
      const metadata = (legacy.metadata ?? {}) as FlyMetadata;
      if (!(legacy.apiKey && metadata.organizationSlug)) return null;
      await mirrorFlyProviderConnectionInTransaction(transaction, {
        organizationId,
        organizationSlug: metadata.organizationSlug,
        encryptedCredential: legacy.apiKey,
        enabled: legacy.enabled,
        status: "ready",
        now,
      });
      return legacy;
    });
    if (!updated) {
      throw new Error(
        "Fly provider connection changed during testing. Test it again."
      );
    }
    return sanitizeFlyProviderConnection(updated);
  } catch (error) {
    await knowledgeDb.transaction(async (transaction) => {
      const now = new Date();
      const [legacy] = await transaction
        .update(schema.aiProviderConnections)
        .set({
          status: "degraded",
          lastTestedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.aiProviderConnections.id, connection.id),
            eq(schema.aiProviderConnections.updatedAt, connection.updatedAt),
          ),
        )
        .returning();
      const metadata = (legacy?.metadata ?? {}) as FlyMetadata;
      if (legacy?.apiKey && metadata.organizationSlug) {
        await mirrorFlyProviderConnectionInTransaction(transaction, {
          organizationId,
          organizationSlug: metadata.organizationSlug,
          encryptedCredential: legacy.apiKey,
          enabled: legacy.enabled,
          status: "degraded",
          now,
        });
      }
    });
    throw error;
  }
}
