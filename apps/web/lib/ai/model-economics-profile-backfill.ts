import {
  createGatewayModelEconomicsProfile,
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
    reason: "unsupported_provider" | "missing_capacity_metadata";
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

    const provider =
      row.gatewayProvider === "lumi" &&
      asRecord(row.metadata).protocol === "anthropic"
        ? "anthropic"
        : row.gatewayProvider;
    const existing = readGatewayModelEconomicsProfile(row.metadata, {
      provider,
      model: row.rawModelId,
    });
    if (existing) {
      alreadyComplete += 1;
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
