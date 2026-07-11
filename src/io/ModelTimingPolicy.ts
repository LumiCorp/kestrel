import type { ModelRequest } from "../kestrel/contracts/model-io.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

export interface ModelTimingPolicyConfig {
  phaseCapMs: number;
  reserveMs: number;
  minTimeoutMs: number;
}

export const DEFAULT_MODEL_TIMING_POLICY: ModelTimingPolicyConfig = {
  phaseCapMs: 180_000,
  reserveMs: 1_000,
  minTimeoutMs: 2_500,
};

export function deriveModelTimeoutMs(
  request: ModelRequest,
  config: ModelTimingPolicyConfig,
): number {
  validateTimingPolicyConfig(config);
  const metadata = parseModelTimingMetadata(request.metadata);
  const remainingMs =
    typeof metadata?.runtimeBudgetRemainingMs === "number"
      ? metadata.runtimeBudgetRemainingMs
      : undefined;
  const explicitPhaseCap =
    typeof metadata?.phaseTimeoutMs === "number" ? metadata.phaseTimeoutMs : undefined;
  const phaseCap = Math.max(config.minTimeoutMs, explicitPhaseCap ?? config.phaseCapMs);

  if (remainingMs === undefined) {
    return phaseCap;
  }

  const budgetLimited = Math.max(0, remainingMs - config.reserveMs);
  if (budgetLimited < config.minTimeoutMs) {
    return budgetLimited;
  }
  return Math.min(phaseCap, budgetLimited);
}

function parseModelTimingMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function validateTimingPolicyConfig(config: ModelTimingPolicyConfig): void {
  if (
    Number.isFinite(config.phaseCapMs) === false ||
    Number.isFinite(config.reserveMs) === false ||
    Number.isFinite(config.minTimeoutMs) === false
  ) {
    throw createRuntimeFailure("IO_POLICY_INVALID", "Model timing policy must use finite numeric fields.", {
      subsystem: "runtime",
      classification: "configuration",
      recoverable: false,
      config,
    });
  }
}
