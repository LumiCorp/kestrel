import type {
  CiChangedPath,
  CiGateId,
  CiGatePlan,
  GateProfile,
  RiskTier,
} from "./contracts.js";

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
    required_checks: [
      "typecheck",
      "unit",
      "integration",
      "prompt-suite-stable",
      "evals:release-check",
    ],
  },
  {
    tier: "critical",
    required_checks: [
      "typecheck",
      "unit",
      "integration",
      "evals:release-check",
      "prompt-suite-release",
      "build",
    ],
  },
];

export function classifyRiskTier(changedPaths: string[]): RiskTier {
  if (changedPaths.some((path) => path.startsWith("db/migrations/"))) {
    return "critical";
  }
  if (
    changedPaths.some(
      (path) => path.startsWith("src/engine/") || path.startsWith("src/store/")
    )
  ) {
    return "high";
  }
  if (
    changedPaths.some(
      (path) => path.startsWith("src/") || path.startsWith("tools/")
    )
  ) {
    return "medium";
  }
  return "low";
}

export function checksForTier(
  tier: RiskTier,
  profiles = DEFAULT_GATE_PROFILES
): string[] {
  return (
    profiles.find((profile) => profile.tier === tier)?.required_checks ?? []
  );
}

export const CI_GATE_IDS = [
  "static-policy",
  "runtime-unit",
  "package-contracts",
  "web-unit",
  "web-build",
  "service-contracts",
  "postgres-integration",
  "kestrel-one-product",
  "docs-contracts",
  "desktop-contracts",
  "package-macos",
] as const satisfies readonly CiGateId[];

const ALL_GATES = [...CI_GATE_IDS];
const STATIC: CiGateId[] = ["static-policy"];
const RUNTIME: CiGateId[] = [
  ...STATIC,
  "runtime-unit",
  "package-contracts",
  "web-unit",
  "web-build",
  "kestrel-one-product",
  "desktop-contracts",
  "package-macos",
];
const WEB: CiGateId[] = [
  ...STATIC,
  "web-unit",
  "web-build",
  "kestrel-one-product",
];
const POSTGRES: CiGateId[] = ["postgres-integration"];
const SERVICES: CiGateId[] = [
  ...STATIC,
  "service-contracts",
  "web-unit",
  "web-build",
  "kestrel-one-product",
];

interface OwnershipRule {
  id: string;
  risk: RiskTier;
  gates: CiGateId[];
  owns(path: string): boolean;
}

function prefix(...prefixes: string[]) {
  return (path: string) => prefixes.some((value) => path.startsWith(value));
}

function exact(...paths: string[]) {
  const owned = new Set(paths);
  return (path: string) => owned.has(path);
}

const CI_OWNERSHIP_RULES: OwnershipRule[] = [
  {
    id: "global-build-and-ci",
    risk: "critical",
    gates: ALL_GATES,
    owns: (path) =>
      prefix(".github/", "scripts/ci/")(path) ||
      exact(
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.json",
        ".npmrc",
        "scripts/classify-gates.ts"
      )(path),
  },
  {
    id: "root-runtime",
    risk: "high",
    gates: RUNTIME,
    owns: prefix(
      ".kestrel/",
      "agents/",
      "apps/cli/",
      "benchmarks/",
      "bin/",
      "cli/",
      "coding-agent-review/",
      "db/",
      "evals/",
      "models/",
      "src/",
      "tools/"
    ),
  },
  {
    id: "runtime-tests-and-scripts",
    risk: "high",
    gates: RUNTIME,
    owns: prefix("tests/", "scripts/"),
  },
  {
    id: "public-packages",
    risk: "high",
    gates: RUNTIME,
    owns: prefix(
      "packages/protocol/",
      "packages/sdk/",
      "packages/ai-sdk/",
      "packages/next/",
      "packages/observability/"
    ),
  },
  {
    id: "service-packages",
    risk: "high",
    gates: SERVICES,
    owns: prefix(
      "packages/environment-auth/",
      "packages/mcp-security/",
      "apps/environment-router/",
      "apps/workspace-runtime/",
      "apps/mcp-service/",
      "deploy/"
    ),
  },
  {
    id: "kestrel-one",
    risk: "high",
    gates: WEB,
    owns: prefix("apps/web/"),
  },
  {
    id: "kestrel-one-postgres",
    risk: "critical",
    gates: POSTGRES,
    owns: (path) =>
      prefix(
        "apps/web/drizzle/",
        "apps/web/lib/db/",
        "apps/web/lib/turns/",
        "apps/web/lib/environments/",
        "apps/web/lib/apps/",
        "apps/web/lib/integrations/"
      )(path) || path.endsWith(".postgres.test.ts"),
  },
  {
    id: "desktop",
    risk: "high",
    gates: [...STATIC, "desktop-contracts", "package-macos"],
    owns: prefix("apps/desktop/"),
  },
  {
    id: "documentation",
    risk: "low",
    gates: [...STATIC, "docs-contracts"],
    owns: (path) =>
      prefix("apps/docs/", "docs/")(path) ||
      /^(?:[A-Z][A-Z0-9_-]*|design-qa|research)\.md$/u.test(path) ||
      exact("LICENSE")(path),
  },
  {
    id: "repository-metadata",
    risk: "medium",
    gates: STATIC,
    owns: exact(
      ".dockerignore",
      ".env.example",
      ".gitattributes",
      ".gitignore",
      ".worktreeinclude",
      ".vercelignore",
      "docker-compose.yml"
    ),
  },
];

const riskRank: Record<RiskTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function planCiGates(input: {
  base: string;
  head: string;
  changes: CiChangedPath[];
  full?: boolean | undefined;
}): CiGatePlan {
  const gates = {} as CiGatePlan["gates"];
  for (const id of CI_GATE_IDS) gates[id] = { selected: false, reasons: [] };
  const unownedPaths = new Set<string>();
  let risk: RiskTier = "low";

  const select = (gate: CiGateId, reason: string) => {
    gates[gate].selected = true;
    if (!gates[gate].reasons.includes(reason)) gates[gate].reasons.push(reason);
  };

  if (input.full) {
    for (const gate of CI_GATE_IDS) select(gate, "full validation requested");
    risk = "critical";
  } else {
    for (const change of input.changes) {
      const paths = [change.path, change.previousPath].filter(
        (value): value is string => Boolean(value)
      );
      for (const path of paths) {
        const matches = CI_OWNERSHIP_RULES.filter((rule) => rule.owns(path));
        if (matches.length === 0) {
          unownedPaths.add(path);
          for (const gate of CI_GATE_IDS) select(gate, `unowned path: ${path}`);
          risk = "critical";
          continue;
        }
        for (const rule of matches) {
          if (riskRank[rule.risk] > riskRank[risk]) risk = rule.risk;
          for (const gate of rule.gates) select(gate, `${rule.id}: ${path}`);
        }
      }
    }
  }

  if (input.changes.length === 0 && !input.full) {
    select("static-policy", "empty diff safety check");
  }

  return {
    version: 1,
    base: input.base,
    head: input.head,
    full: Boolean(input.full),
    risk,
    changes: input.changes,
    unownedPaths: [...unownedPaths].sort(),
    gates,
  };
}

export function classifyOwnedPath(path: string): string[] {
  return CI_OWNERSHIP_RULES.filter((rule) => rule.owns(path)).map(
    (rule) => rule.id
  );
}

export function parseCiNameStatus(raw: string): CiChangedPath[] {
  const fields = raw.split("\0").filter(Boolean);
  const changes: CiChangedPath[] = [];
  for (let index = 0; index < fields.length; ) {
    const rawStatus = fields[index++] ?? "";
    const status = rawStatus[0] as CiChangedPath["status"];
    if (status === "R" || status === "C") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!(path && previousPath))
        throw new Error(`Malformed ${rawStatus} diff entry.`);
      changes.push({ status, previousPath, path });
      continue;
    }
    const path = fields[index++];
    if (!path) throw new Error(`Malformed ${rawStatus} diff entry.`);
    changes.push({ status, path });
  }
  return changes;
}
