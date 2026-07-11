import type { GateProfile, RiskTier } from "./contracts.js";

export const DEFAULT_GATE_PROFILES: GateProfile[] = [
  {
    tier: "low",
    required_checks: ["typecheck", "smoke"],
  },
  {
    tier: "medium",
    required_checks: ["typecheck", "unit", "prompt-suite-fast"],
  },
  {
    tier: "high",
    required_checks: ["typecheck", "unit", "integration", "prompt-suite-stable", "evals:release-check"],
  },
  {
    tier: "critical",
    required_checks: ["typecheck", "unit", "integration", "evals:release-check", "prompt-suite-release", "build"],
  },
];

export function classifyRiskTier(changedPaths: string[]): RiskTier {
  if (changedPaths.some((path) => path.startsWith("db/migrations/"))) {
    return "critical";
  }
  if (changedPaths.some((path) => path.startsWith("src/engine/") || path.startsWith("src/store/"))) {
    return "high";
  }
  if (changedPaths.some((path) => path.startsWith("src/") || path.startsWith("tools/"))) {
    return "medium";
  }
  return "low";
}

export function checksForTier(tier: RiskTier, profiles = DEFAULT_GATE_PROFILES): string[] {
  return profiles.find((profile) => profile.tier === tier)?.required_checks ?? [];
}
