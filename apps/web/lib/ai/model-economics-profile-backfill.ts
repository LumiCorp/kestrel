import {
  createGatewayModelEconomicsProfile,
  createKestrelDefaultEconomicsProfile,
  getProviderEconomicsFallbackCapability,
  getGatewayModelEconomicsProvider,
  readGatewayModelEconomicsProfile,
  withGatewayModelEconomicsProfile,
  type GatewayModelEconomicsProfile,
} from "./model-economics-profile";
import { normalizeOpenAICompatibleBaseUrl } from "./gateway-utils";

export type GatewayModelEconomicsBackfillRow = {
  id: string;
  organizationId: string | null;
  gatewayId: string;
  rawModelId: string;
  modality: string;
  approved: boolean;
  metadata: unknown;
  gatewayProvider: string;
  gatewayBaseUrl?: string | null;
  credentialRevision?: number;
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

export type OpenRouterBackfillClassification =
  | "already_valid"
  | "repairable_provider_facts"
  | "repairable_equal_capacity"
  | "exact_id_mismatch"
  | "router_or_non_exact"
  | "authentication_failure"
  | "lookup_failure"
  | "provider_transient_failure"
  | "missing_capacity_metadata"
  | "concurrency_or_stale";

/** Classify a live OpenRouter resolution for operator-facing dry-run output. */
export function classifyOpenRouterBackfillResolution(input: {
  requestedModelId: string;
  details?: Record<string, unknown>;
  profile?: GatewayModelEconomicsProfile;
  alreadyValid?: boolean;
  error?: unknown;
}): OpenRouterBackfillClassification {
  if (input.alreadyValid) return "already_valid";
  if (input.error) {
    const error = input.error as {
      status?: number;
      retryable?: boolean;
      resolvedModelId?: string;
      message?: string;
    };
    if (error.message?.includes("changed while provider details were resolving")) {
      return "concurrency_or_stale";
    }
    if (error.resolvedModelId && error.resolvedModelId !== input.requestedModelId) {
      return "exact_id_mismatch";
    }
    if (error.message?.includes("exact author/slug form")) {
      return "router_or_non_exact";
    }
    if (error.status === 401 || error.status === 403) return "authentication_failure";
    if (error.retryable || (error.status !== undefined && error.status >= 500)) {
      return "provider_transient_failure";
    }
    return "lookup_failure";
  }
  if (input.profile === undefined) return "missing_capacity_metadata";
  if (input.profile.contextWindowTokens === input.profile.maxOutputTokens) {
    return "repairable_equal_capacity";
  }
  return "repairable_provider_facts";
}

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
        catalog.model === row.rawModelId);
    const providerProfile = createGatewayModelEconomicsProfile({
      provider,
      model: row.rawModelId,
      metadata: row.metadata,
    });
    const fallbackEligible =
      getProviderEconomicsFallbackCapability(row.gatewayProvider).supportsConservativeFallback &&
      identified &&
      providerProfile === undefined &&
      (row.gatewayProvider !== "runpod" ||
        Boolean(
          row.gatewayBaseUrl &&
            (catalog?.kestrelRunPodValidation as { rawModelId?: string; baseUrl?: string } | undefined)
              ?.rawModelId === row.rawModelId &&
            normalizeOpenAICompatibleBaseUrl(
              (catalog?.kestrelRunPodValidation as { baseUrl?: string } | undefined)?.baseUrl ?? "",
            ) === normalizeOpenAICompatibleBaseUrl(row.gatewayBaseUrl ?? ""),
        ));
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
