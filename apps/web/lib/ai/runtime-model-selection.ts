import "server-only";

import { and, eq, isNull, or } from "drizzle-orm";
import { type knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  isKestrelRuntimeLanguageProvider,
  parseDesktopLocalRuntimeModelId,
  selectGatewayModelSelection,
} from "./gateway-utils";
import {
  getGatewayModelEconomicsProvider,
  readGatewayModelEconomicsProfile,
} from "./model-economics-profile";
import {
  isHostedModelProvider,
  isHostedModelRoleReady,
  readHostedModelReadiness,
} from "./hosted-model-readiness";
import { isDesktopModelRoleReady } from "../environments/desktop-model-readiness";

export type RuntimeModelSelectionTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

export type ResolvedKestrelRuntimeModelIdentity = {
  provider: string;
  rawModelId: string;
};

async function listAvailableKestrelRuntimeGatewayModels(
  transaction: RuntimeModelSelectionTransaction,
  input: {
    organizationId: string;
    environmentId: string;
    requiredRole?: string | undefined;
  },
) {
  const rows = await transaction
    .select({
      id: schema.aiGatewayModels.id,
      alias: schema.aiGatewayModels.alias,
      rawModelId: schema.aiGatewayModels.rawModelId,
      isDefault: schema.aiGatewayModels.isDefault,
      gatewayProvider: schema.aiGateways.provider,
      credentialRevision: schema.aiGateways.credentialRevision,
      credentialStatus: schema.aiGateways.credentialStatus,
      metadata: schema.aiGatewayModels.metadata,
    })
    .from(schema.aiGatewayModels)
    .innerJoin(
      schema.aiGateways,
      eq(schema.aiGateways.id, schema.aiGatewayModels.gatewayId),
    )
    .where(
      and(
        eq(schema.aiGatewayModels.organizationId, input.organizationId),
        eq(schema.aiGatewayModels.approved, true),
        eq(schema.aiGatewayModels.modality, "language"),
        eq(schema.aiGateways.organizationId, input.organizationId),
        eq(schema.aiGateways.enabled, true),
        or(
          isNull(schema.aiGateways.environmentId),
          eq(schema.aiGateways.environmentId, input.environmentId),
        ),
      ),
    );
  return rows
    .filter((row) => {
      if (!isKestrelRuntimeLanguageProvider(row.gatewayProvider)) return false;
      const provider = getGatewayModelEconomicsProvider({
        gatewayProvider: row.gatewayProvider,
        modality: "language",
        metadata: row.metadata,
      });
      return (
        provider !== undefined &&
        readGatewayModelEconomicsProfile(row.metadata, {
          provider,
          model: row.rawModelId,
        }) !== undefined &&
        (!isHostedModelProvider(row.gatewayProvider) ||
          isHostedModelRoleReady(
            readHostedModelReadiness({
              approved: true,
              gatewayEnabled: true,
              gatewayReachable: row.credentialStatus === "ready",
              provider: row.gatewayProvider,
              modelId: row.rawModelId,
              metadata: row.metadata,
              credentialRevision: row.credentialRevision,
            }),
            input.requiredRole,
          ))
      );
    })
    .map((row) => ({
      ...row,
      id: row.alias?.trim() || `${row.gatewayProvider}/${row.rawModelId}`,
    }));
}

export async function findUnavailableKestrelRuntimeModelSelectionsInTransaction(
  transaction: RuntimeModelSelectionTransaction,
  input: {
    organizationId: string;
    environmentId: string;
    modelIds: readonly string[];
    requiredRole?: string | undefined;
  },
) {
  const modelIds = [...new Set(input.modelIds.map((value) => value.trim()))].filter(
    Boolean,
  );
  if (modelIds.length === 0) return new Set<string>();

  const gatewayModels = await listAvailableKestrelRuntimeGatewayModels(
    transaction,
    input,
  );

  const desktopSelections = new Map<
    string,
    NonNullable<ReturnType<typeof parseDesktopLocalRuntimeModelId>>
  >();
  const unavailable = new Set<string>();
  for (const modelId of modelIds) {
    try {
      const desktop = parseDesktopLocalRuntimeModelId(modelId);
      if (desktop) desktopSelections.set(modelId, desktop);
    } catch {
      unavailable.add(modelId);
    }
  }
  const desktopConnection =
    desktopSelections.size > 0
      ? await transaction.query.desktopEnvironmentConnections.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.organizationId, input.organizationId),
              eq(table.environmentId, input.environmentId),
              eq(table.status, "active"),
            ),
          columns: { advertisedModels: true },
        })
      : null;

  for (const modelId of modelIds) {
    if (unavailable.has(modelId)) continue;
    const desktop = desktopSelections.get(modelId);
    if (desktop) {
      const advertised = desktopConnection?.advertisedModels.some((candidate) =>
        isDesktopModelRoleReady({
          model: candidate,
          provider: desktop.provider,
          modelId: desktop.model,
          role: input.requiredRole,
        }),
      );
      if (!advertised) unavailable.add(modelId);
      continue;
    }
    if (!selectGatewayModelSelection(gatewayModels, modelId)) {
      unavailable.add(modelId);
    }
  }
  return unavailable;
}

export async function isKestrelRuntimeModelSelectionAvailableInTransaction(
  transaction: RuntimeModelSelectionTransaction,
  input: {
    organizationId: string;
    environmentId: string;
    modelId: string;
    requiredRole?: string | undefined;
  },
) {
  const modelId = input.modelId.trim();
  if (!modelId) return false;
  const unavailable =
    await findUnavailableKestrelRuntimeModelSelectionsInTransaction(
      transaction,
      { ...input, modelIds: [modelId] },
    );
  return !unavailable.has(modelId);
}

export async function resolveKestrelRuntimeModelIdentityInTransaction(
  transaction: RuntimeModelSelectionTransaction,
  input: {
    organizationId: string;
    environmentId: string;
    modelId: string;
  },
): Promise<ResolvedKestrelRuntimeModelIdentity | null> {
  const modelId = input.modelId.trim();
  if (!modelId) return null;
  const unavailable =
    await findUnavailableKestrelRuntimeModelSelectionsInTransaction(
      transaction,
      { ...input, modelIds: [modelId] },
    );
  if (unavailable.has(modelId)) return null;
  const desktop = parseDesktopLocalRuntimeModelId(modelId);
  if (desktop) {
    return { provider: desktop.provider, rawModelId: desktop.model };
  }
  const selected = selectGatewayModelSelection(
    await listAvailableKestrelRuntimeGatewayModels(transaction, input),
    modelId,
  );
  return selected
    ? { provider: selected.gatewayProvider, rawModelId: selected.rawModelId }
    : null;
}
