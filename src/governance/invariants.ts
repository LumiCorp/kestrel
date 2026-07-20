import type { LintInvariant } from "./contracts.js";

export interface InvariantViolation {
  rule_id: string;
  file: string;
  message: string;
}

export const DEFAULT_LINT_INVARIANTS: LintInvariant[] = [
  {
    rule_id: "parse-boundary",
    scope: "tools/**,src/io/**",
    message_template: "Parse external inputs at boundaries before use.",
    autofix_available: false,
    severity: "warn",
    severity_overrides: [
      { path_prefix: "src/effects/", severity: "error" },
      { path_prefix: "src/io/", severity: "error" },
      { path_prefix: "tools/", severity: "error" },
    ],
  },
  {
    rule_id: "normalized-error-shape",
    scope: "src/**,apps/**",
    message_template: "Errors should use normalized code + message fields.",
    autofix_available: false,
    severity: "warn",
    severity_overrides: [
      { path_prefix: "agents/reference-react/src/", severity: "error" },
      { path_prefix: "apps/web/app/api/kchat/profile/", severity: "error" },
      { path_prefix: "apps/web/app/api/kchat/control/", severity: "error" },
      { path_prefix: "apps/web/app/api/kchat/stream/", severity: "error" },
      { path_prefix: "apps/web/app/api/kchat/runs/", severity: "error" },
      { path_prefix: "apps/web/app/api/kchat/sessions/", severity: "error" },
      { path_prefix: "apps/web/app/api/kchat/runtime/", severity: "error" },
      { path_prefix: "apps/web/app/api/kchat/artifacts/", severity: "error" },
      { path_prefix: "apps/web/lib/server/", severity: "error" },
      { path_prefix: "src/engine/", severity: "error" },
      { path_prefix: "src/live/", severity: "error" },
      { path_prefix: "src/store/", severity: "error" },
      { path_prefix: "src/web/", severity: "error" },
      { path_prefix: "src/effects/", severity: "error" },
      { path_prefix: "src/io/", severity: "error" },
      { path_prefix: "tools/", severity: "error" },
    ],
  },
  {
    rule_id: "route-triage-contract",
    scope: "src/governance/contracts.ts",
    message_template: "Route triage contract must expose canonical operator triage fields.",
    autofix_available: false,
    severity: "warn",
    severity_overrides: [
      { path_prefix: "src/governance/contracts.ts", severity: "error" },
    ],
  },
  {
    rule_id: "reference-react-command-processor-mutation-authority",
    scope: "agents/reference-react/src/steps/{acter,execStates}.ts",
    message_template: "Reference React execution steps must route state patches through command-processor checkpoint helpers.",
    autofix_available: false,
    severity: "error",
  },
];

export function checkInvariantViolations(input: {
  file: string;
  content: string;
}): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (
    (input.file.includes("/src/effects/") || input.file.includes("/src/io/") || input.file.includes("/tools/")) &&
    input.file.endsWith("/tools/contracts.ts") === false
  ) {
    const hasBoundaryUnknown = /\b[a-zA-Z_$][\w$]*\s*:\s*unknown\b/.test(input.content);
    const hasParse = /\b(?:parse|validate)[A-Za-z0-9_]*\b|\bzod\b|\bajv\b|\basRuntimeError\b/i.test(input.content);
    if (hasBoundaryUnknown && hasParse === false) {
      violations.push({
        rule_id: "parse-boundary",
        file: input.file,
        message: "Boundary code handles unknown input without visible parse/validate call.",
      });
    }
  }

  if (/throw new Error\(/.test(input.content) && /\bcode:\s*["'][A-Z0-9_]+["']/.test(input.content) === false) {
    violations.push({
      rule_id: "normalized-error-shape",
      file: input.file,
      message: "Prefer normalized error shape with explicit machine-readable code.",
    });
  }

  if (input.file.endsWith("/src/governance/contracts.ts")) {
    const requiredTokens = [
      "interactionMode",
      "executionLane",
      "extractorCandidateTools",
      "plannerAction",
      "topFailure",
      "replayVerdict",
      "uiEvidenceInventory",
      "internetSignals",
    ];
    const interfaceStart = input.content.indexOf("export interface OperatorTriageSummary {");
    const interfaceEnd = interfaceStart === -1 ? -1 : input.content.indexOf("\n}", interfaceStart);
    const interfaceBlock =
      interfaceStart === -1 || interfaceEnd === -1
        ? ""
        : input.content.slice(interfaceStart, interfaceEnd);
    const missing = requiredTokens.filter((token) => interfaceBlock.includes(token) === false);
    if (missing.length > 0) {
      violations.push({
        rule_id: "route-triage-contract",
        file: input.file,
        message: `OperatorTriageSummary is missing canonical fields: ${missing.join(", ")}`,
      });
    }
  }

  if (
    (
    input.file.endsWith("/agents/reference-react/src/steps/acter.ts") ||
    input.file.endsWith("/agents/reference-react/src/steps/execStates.ts")) && /\bstatePatch\s*:/.test(input.content)
  ) {
      violations.push({
        rule_id: "reference-react-command-processor-mutation-authority",
        file: input.file,
        message:
          "Execution steps must not assemble Transition.statePatch directly; add or reuse a command-processor checkpoint helper.",
      });
    }

  return violations;
}

export function resolveInvariantSeverity(
  invariant: LintInvariant | undefined,
  file: string,
): "error" | "warn" {
  if (invariant === undefined) {
    return "warn";
  }

  const override = invariant.severity_overrides?.find((candidate) =>
    file.includes(`/${candidate.path_prefix}`) || file.startsWith(candidate.path_prefix),
  );
  return override?.severity ?? invariant.severity;
}
