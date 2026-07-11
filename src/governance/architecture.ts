import type { ArchitectureRuleSet } from "./contracts.js";

export interface ArchitectureViolation {
  file: string;
  fromLayer: string;
  toLayer: string;
  reason: string;
}

export function evaluateArchitecture(input: {
  file: string;
  imports: string[];
  rules: ArchitectureRuleSet[];
}): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  const fromLayer = detectLayer(input.file);
  if (fromLayer === null) {
    return violations;
  }

  const rule = input.rules.find((candidate) => candidate.layer === fromLayer);
  if (rule === undefined) {
    return violations;
  }

  for (const imported of input.imports) {
    const toLayer = detectLayer(imported);
    if (toLayer === null || toLayer === fromLayer) {
      continue;
    }

    if (isException(rule, fromLayer, toLayer)) {
      continue;
    }

    if (rule.can_depend_on.includes(toLayer) === false) {
      violations.push({
        file: input.file,
        fromLayer,
        toLayer,
        reason: `layer '${fromLayer}' cannot depend on '${toLayer}'`,
      });
    }
  }

  return violations;
}

export function detectLayer(path: string): string | null {
  if (path.includes("/src/kestrel/contracts/")) return "contracts";
  if (path.includes("/src/engine/")) return "engine";
  if (path.includes("/src/store/")) return "store";
  if (path.includes("/src/io/")) return "io";
  if (path.includes("/tools/")) return "tools";
  if (path.includes("/apps/")) return "apps";
  if (path.includes("/cli/")) return "cli";
  return null;
}

function isException(rule: ArchitectureRuleSet, from: string, to: string): boolean {
  const now = Date.now();
  return (rule.exceptions ?? []).some((entry) => {
    if (entry.from !== from || entry.to !== to) {
      return false;
    }
    const expiry = new Date(entry.expires_at).getTime();
    return Number.isFinite(expiry) && expiry >= now;
  });
}
