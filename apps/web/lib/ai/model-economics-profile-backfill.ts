import {
  createGatewayModelEconomicsProfile,
  createKestrelDefaultEconomicsProfile,
  getGatewayModelEconomicsProvider,
  readGatewayModelEconomicsProfile,
  withGatewayModelEconomicsProfile,
  type GatewayModelEconomicsProfile,
} from "./model-economics-profile";

export type GatewayModelEconomicsBackfillRow = {
  id: string;
  organizationId: string | null;
  gatewayId: string;
  rawModelId: string;
  modality: string;
  approved: boolean;
  metadata: unknown;
  gatewayProvider: string;
  updatedAt?: Date | null;
};

export type GatewayModelEconomicsBackfillUpdate = {
  id: string;
  metadata: Record<string, unknown>;
  profile: GatewayModelEconomicsProfile;
  expectedUpdatedAt?: Date | null;
};

export type GatewayModelEconomicsBackfillPlan = {
  scanned: number;
  repairable: number;
  alreadyComplete: number;
  skipped: Array<{
    id: string;
    provider: string;
    model: string;
    reason:
      | "unsupported_provider"
      | "missing_capacity_metadata"
      | "openrouter_resolution_required"
      | "identity_unverified";
  }>;
  updates: GatewayModelEconomicsBackfillUpdate[];
};

const KESTREL_RUNTIME_LANGUAGE_PROVIDERS = new Set([
  "anthropic",
  "lumi",
  "ollama",
  "openai",
  "openrouter",
  "runpod",
]);

/**
 * Build an idempotent repair plan for approved hosted language models. This is
 * deliberately pure so the production script can be dry-run tested without a
 * database and an operator can review the exact rows before applying them.
 */
export function planGatewayModelEconomicsProfileBackfill(
  rows: readonly GatewayModelEconomicsBackfillRow[],
): GatewayModelEconomicsBackfillPlan {
  const updates: GatewayModelEconomicsBackfillUpdate[] = [];
  const skipped: GatewayModelEconomicsBackfillPlan["skipped"] = [];
  let alreadyComplete = 0;

  for (const row of rows) {
    if (!KESTREL_RUNTIME_LANGUAGE_PROVIDERS.has(row.gatewayProvider)) {
      skipped.push({
        id: row.id,
        provider: row.gatewayProvider,
        model: row.rawModelId,
        reason: "unsupported_provider",
      });
      continue;
    }

    const provider = getGatewayModelEconomicsProvider({
      gatewayProvider: row.gatewayProvider,
      modality: row.modality,
      metadata: row.metadata,
    });
    if (provider === undefined) {
      skipped.push({
        id: row.id,
        provider: row.gatewayProvider,
        model: row.rawModelId,
        reason: "unsupported_provider",
      });
      continue;
    }
    const existing = readGatewayModelEconomicsProfile(row.metadata, {
      provider,
      model: row.rawModelId,
    });
    if (existing) {
      alreadyComplete += 1;
      continue;
    }

    if (row.gatewayProvider === "openrouter") {
      skipped.push({
        id: row.id,
        provider,
        model: row.rawModelId,
        reason: "openrouter_resolution_required",
      });
      continue;
    }

    const catalog =
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null;
    const identified =
      catalog !== null &&
      (catalog.id === row.rawModelId ||
        catalog.model === row.rawModelId ||
        catalog.name === row.rawModelId);
    const fallbackEligible =
      ["anthropic", "openai", "lumi", "ollama"].includes(row.gatewayProvider) &&
      identified;
    if (fallbackEligible) {
      const profile = createKestrelDefaultEconomicsProfile({
        provider,
        model: row.rawModelId,
      });
      updates.push({
        id: row.id,
        metadata: {
          ...(catalog ?? {}),
          kestrelEconomicsProfile: profile,
          kestrelEconomicsProfileSource: "kestrel_default",
        },
        profile,
        expectedUpdatedAt: row.updatedAt,
      });
      continue;
    }
    if (catalog !== null && !identified) {
      skipped.push({ id: row.id, provider, model: row.rawModelId, reason: "identity_unverified" });
      continue;
    }

    const metadata = withGatewayModelEconomicsProfile({
      metadata: row.metadata,
      provider,
      model: row.rawModelId,
      approved: row.approved,
      modality: row.modality,
    });
    const profile = createGatewayModelEconomicsProfile({
      provider,
      model: row.rawModelId,
      metadata: row.metadata,
    });
    if (!(profile && metadata)) {
      skipped.push({
        id: row.id,
        provider,
        model: row.rawModelId,
        reason: "missing_capacity_metadata",
      });
      continue;
    }
    updates.push({
      id: row.id,
      metadata,
      profile,
      expectedUpdatedAt: row.updatedAt,
    });
  }

  return {
    scanned: rows.length,
    repairable: updates.length,
    alreadyComplete,
    skipped,
    updates,
  };
}
