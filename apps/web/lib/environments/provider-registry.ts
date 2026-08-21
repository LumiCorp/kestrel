import "server-only";

import {
  createFlyProviderClientForNeutralConnection,
  createFlyProviderClient,
} from "./fly-connection";
import { resolveEnvironmentProviderConnection } from "./provider-persistence";
import type { FlyMachinesClient } from "./providers/fly-machines";
import { FlyEnvironmentInfrastructureProviderV2 } from "./providers/fly-v2";
import {
  EnvironmentProviderErrorV2,
  type EnvironmentInfrastructureProviderV2,
} from "./providers/contracts-v2";
import { EnvironmentInfrastructureProviderV2LegacyAdapter } from "./providers/v2-legacy-adapter";
import { knowledgeDb } from "@/lib/knowledge/db";
import { KubernetesConnectorInfrastructureProviderV2 } from "./providers/kubernetes-connector-proxy";

export type ResolvedEnvironmentProvider =
  | {
      kind: "desktop";
      connectionId: null;
      lifecycle: null;
      legacyLifecycle: null;
      flyClient: null;
    }
  | {
      kind: "fly";
      connectionId: string;
      lifecycle: FlyEnvironmentInfrastructureProviderV2;
      legacyLifecycle: EnvironmentInfrastructureProviderV2LegacyAdapter;
      flyClient: FlyMachinesClient;
    }
  | {
      kind: "kubernetes";
      connectionId: string;
      lifecycle: EnvironmentInfrastructureProviderV2;
      legacyLifecycle: EnvironmentInfrastructureProviderV2LegacyAdapter;
      flyClient: null;
    };

export async function resolveEnvironmentProvider(input: {
  organizationId: string;
  environmentId: string;
  operationId?: string | undefined;
  workspaceId?: string | undefined;
}): Promise<ResolvedEnvironmentProvider> {
  const binding = await resolveEnvironmentProviderConnection(input);
  if (!binding) throw new Error("Environment provider binding was not found.");
  if (binding.environment.provider === "desktop") {
    return {
      kind: "desktop",
      connectionId: null,
      lifecycle: null,
      legacyLifecycle: null,
      flyClient: null,
    };
  }
  if (!binding.connection) {
    throw new Error("Hosted Environment provider connection is unavailable.");
  }
  if (binding.environment.provider === "fly") {
    const [flyClient, gatewayResource] = await Promise.all([
      createFlyProviderClientForNeutralConnection({
        organizationId: input.organizationId,
        connectionId: binding.connection.id,
      }),
      knowledgeDb.query.environmentProviderResources.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.environmentId, input.environmentId),
            eq(table.providerConnectionId, binding.connection!.id),
            eq(table.resourceRole, "gateway"),
            isNull(table.workspaceId),
            isNull(table.replacementId),
            isNull(table.deletedAt),
          ),
        columns: { externalId: true },
      }),
    ]);
    const lifecycle = new FlyEnvironmentInfrastructureProviderV2(flyClient);
    return {
      kind: "fly",
      connectionId: binding.connection.id,
      lifecycle,
      legacyLifecycle: new EnvironmentInfrastructureProviderV2LegacyAdapter(
        lifecycle,
        {
          connectionId: binding.connection.id,
          provider: "fly",
          organizationId: input.organizationId,
          environmentId: input.environmentId,
          workspaceId: input.workspaceId,
          gatewayExternalId:
            gatewayResource?.externalId ??
            binding.environment.flyGatewayMachineId ??
            null,
        },
      ),
      flyClient,
    };
  }
  if (!input.operationId) {
    throw new EnvironmentProviderErrorV2({
      code: "PROVIDER_NOT_CONFIGURED",
      message: "Kubernetes lifecycle resolution requires a durable operation identity.",
      evidence: { level: "implementation", phase: "connector.proxy.resolve" },
      retryable: false,
    });
  }
  if (
    binding.connection.status === "revoked" ||
    binding.connection.revokedAt ||
    !binding.connection.connectorId ||
    !binding.environment.workspaceLimit
  ) {
    throw new EnvironmentProviderErrorV2({
      code: "PROVIDER_UNAVAILABLE",
      message: "The bound Kubernetes connector is not ready for lifecycle commands.",
      evidence: { level: "implementation", phase: "connector.proxy.resolve" },
      retryable: true,
    });
  }
  const [connector, gatewayResource] = await Promise.all([
    knowledgeDb.query.infrastructureConnectorConnections.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, binding.connection!.connectorId!),
          eq(table.organizationId, input.organizationId),
          eq(table.providerConnectionId, binding.connection!.id),
          eq(table.status, "active"),
        ),
      columns: { encryptionPublicKey: true },
    }),
    knowledgeDb.query.environmentProviderResources.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
          eq(table.providerConnectionId, binding.connection!.id),
          eq(table.resourceRole, "gateway"),
          isNull(table.workspaceId),
          isNull(table.replacementId),
          isNull(table.deletedAt),
        ),
      columns: { externalId: true },
    }),
  ]);
  if (!connector) {
    throw new EnvironmentProviderErrorV2({
      code: "PROVIDER_UNAVAILABLE",
      message: "The bound Kubernetes connector identity is unavailable.",
      evidence: { level: "implementation", phase: "connector.proxy.resolve" },
      retryable: true,
    });
  }
  const lifecycle = new KubernetesConnectorInfrastructureProviderV2({
    operationId: input.operationId,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    connectionId: binding.connection.id,
    connectorEncryptionPublicKey: connector.encryptionPublicKey,
    configuration: binding.connection.configuration,
    workspaceLimit: binding.environment.workspaceLimit,
    runtimeTemplate: binding.environment.runtimeTemplate,
  });
  return {
    kind: "kubernetes",
    connectionId: binding.connection.id,
    lifecycle,
    legacyLifecycle: new EnvironmentInfrastructureProviderV2LegacyAdapter(
      lifecycle,
      {
        connectionId: binding.connection.id,
        provider: "kubernetes",
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        gatewayExternalId: gatewayResource?.externalId ?? null,
      },
    ),
    flyClient: null,
  };
}

export async function resolveFlyProviderClient(input: {
  organizationId: string;
  environmentId?: string | undefined;
}) {
  if (input.environmentId) {
    const resolved = await resolveEnvironmentProvider({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
    });
    if (resolved.kind !== "fly") {
      throw new Error("Environment is not bound to Fly.");
    }
    return resolved.flyClient;
  }
  return createFlyProviderClient(input.organizationId);
}
