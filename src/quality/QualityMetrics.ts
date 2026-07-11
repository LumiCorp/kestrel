import type { QualityMetrics } from "../kestrel/contracts/events.js";


function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function computeQualityMetrics(input: {
  sessionState: Record<string, unknown>;
  stepsExecuted: number;
  thrashIndex: number;
}): QualityMetrics {
  const rootClaims = Array.isArray(input.sessionState.claims)
    ? input.sessionState.claims
    : [];
  const react = asRecord(input.sessionState.react);
  const reactClaims = Array.isArray(react?.claims) ? react.claims : [];
  const allClaims = [...rootClaims, ...reactClaims]
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => value !== undefined);

  if (allClaims.length === 0) {
    return {
      citationCoverage: 1,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: input.thrashIndex,
    };
  }

  const citedCount = allClaims.filter((claim) => {
    const evidenceIds = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
    return evidenceIds.length > 0;
  }).length;

  const unresolvedClaims = allClaims.filter((claim) => {
    const status = typeof claim.status === "string" ? claim.status : "proposed";
    return status !== "verified";
  }).length;

  const observations = Array.isArray(react?.observations) ? react.observations : [];
  const regressions = observations.filter((item) => {
    const value = asRecord(item);
    return value?.goalMet === false;
  }).length;

  return {
    citationCoverage: Number((citedCount / allClaims.length).toFixed(4)),
    unresolvedClaims,
    reworkRate:
      input.stepsExecuted > 0 ? Number((regressions / input.stepsExecuted).toFixed(4)) : 0,
    thrashIndex: input.thrashIndex,
  };
}
