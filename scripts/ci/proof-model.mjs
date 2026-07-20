export const CI_LANES = [
  "policy",
  "runtime",
  "packages",
  "web",
  "services",
  "postgres",
  "product",
  "desktop",
  "docs",
  "package-macos",
];

const allLanes = [...CI_LANES];

const startsWith = (...prefixes) => (file) =>
  prefixes.some((prefix) => file.startsWith(prefix));
const exact = (...files) => {
  const owned = new Set(files);
  return (file) => owned.has(file);
};

export const CI_COMPONENTS = [
  {
    id: "ci-system",
    lanes: allLanes,
    owns: (file) =>
      startsWith(".github/", "scripts/ci/", "tests/proof/")(file) ||
      exact(
        "AGENTS.md",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        ".npmrc",
        "tsconfig.json",
      )(file),
  },
  {
    id: "runtime",
    lanes: ["policy", "runtime"],
    owns: (file) =>
      startsWith(
        ".kestrel/",
        "agents/",
        "apps/cli/",
        "benchmarks/",
        "bin/",
        "cli/",
        "coding-agent-review/",
        "db/",
        "models/",
        "src/",
        "tools/",
        "tests/",
      )(file) &&
      !startsWith("tests/e2e/sdk-ecosystem/", "tests/macos/", "tests/ops/tui/", "tests/proof/")(file),
  },
  {
    id: "runtime-scripts",
    lanes: ["policy", "runtime"],
    owns: (file) =>
      startsWith("scripts/")(file) &&
      !startsWith(
        "scripts/ci/",
        "scripts/package-desktop",
        "scripts/package-cli",
        "scripts/check-desktop-release",
        "scripts/check-cli-release",
        "scripts/prepare-desktop-package",
        "scripts/prepare-desktop-postgres",
      )(file),
  },
  {
    id: "ruhroh-config",
    lanes: ["policy"],
    owns: startsWith("evals/"),
  },
  {
    id: "public-packages",
    lanes: ["policy", "packages", "runtime", "web", "services", "product", "desktop"],
    owns: startsWith(
      "packages/protocol/",
      "packages/sdk/",
      "packages/ai-sdk/",
      "packages/next/",
      "packages/observability/",
      "tests/e2e/sdk-ecosystem/",
    ),
  },
  {
    id: "hosted-services",
    lanes: ["policy", "services", "web", "product"],
    owns: startsWith(
      "packages/environment-auth/",
      "packages/mcp-security/",
      "apps/environment-router/",
      "apps/workspace-runtime/",
      "apps/mcp-service/",
      "deploy/",
    ),
  },
  {
    id: "web",
    lanes: ["policy", "web", "product"],
    owns: startsWith("apps/web/"),
  },
  {
    id: "postgres",
    lanes: ["postgres"],
    owns: (file) =>
      startsWith(
        "apps/web/drizzle/",
        "apps/web/lib/db/",
        "apps/web/lib/turns/",
        "apps/web/lib/environments/",
        "apps/web/lib/apps/",
        "apps/web/lib/integrations/",
      )(file) || file.endsWith(".postgres.test.ts"),
  },
  {
    id: "postgres-tui",
    lanes: ["postgres"],
    owns: startsWith("tests/ops/tui/"),
  },
  {
    id: "desktop",
    lanes: ["policy", "desktop"],
    owns: startsWith("apps/desktop/"),
  },
  {
    id: "macos-packaging",
    lanes: ["package-macos"],
    owns: (file) =>
      startsWith(
        "scripts/package-desktop",
        "scripts/package-cli",
        "scripts/check-desktop-release",
        "scripts/check-cli-release",
        "scripts/prepare-desktop-package",
        "scripts/prepare-desktop-postgres",
        "tests/macos/",
      )(file) ||
      exact(
        "apps/desktop/package.json",
        "apps/desktop/src/packageConfig.ts",
        "apps/desktop/tests/packageConfig.test.ts",
      )(file),
  },
  {
    id: "documentation",
    lanes: ["policy", "docs"],
    owns: (file) =>
      startsWith("apps/docs/", "docs/")(file) ||
      /^(?:[A-Z][A-Z0-9_-]*|design-qa|research)\.md$/u.test(file) ||
      file === "LICENSE",
  },
  {
    id: "repository-metadata",
    lanes: ["policy"],
    owns: exact(
      ".dockerignore",
      ".env.example",
      ".gitattributes",
      ".gitignore",
      ".worktreeinclude",
      ".vercelignore",
      "docker-compose.yml",
    ),
  },
];

export function parseNameStatus(raw) {
  const fields = raw.split("\0").filter(Boolean);
  const changes = [];
  for (let index = 0; index < fields.length; ) {
    const rawStatus = fields[index++] ?? "";
    const status = rawStatus[0];
    if (status === "R" || status === "C") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!(path && previousPath)) throw new Error(`Malformed ${rawStatus} diff entry.`);
      changes.push({ status, previousPath, path });
      continue;
    }
    const path = fields[index++];
    if (!path) throw new Error(`Malformed ${rawStatus} diff entry.`);
    changes.push({ status, path });
  }
  return changes;
}

export function componentsForPath(file) {
  return CI_COMPONENTS.filter((component) => component.owns(file)).map(
    (component) => component.id,
  );
}

export function createCiPlan({ base, head, changes, full = false }) {
  const lanes = Object.fromEntries(
    CI_LANES.map((lane) => [lane, { selected: false, reasons: [] }]),
  );
  const unownedPaths = new Set();
  const components = new Set();

  const select = (lane, reason) => {
    lanes[lane].selected = true;
    if (!lanes[lane].reasons.includes(reason)) lanes[lane].reasons.push(reason);
  };

  if (full) {
    for (const lane of CI_LANES) select(lane, "full validation requested");
    for (const component of CI_COMPONENTS) components.add(component.id);
  } else {
    for (const change of changes) {
      for (const file of [change.path, change.previousPath].filter(Boolean)) {
        const owners = CI_COMPONENTS.filter((component) => component.owns(file));
        if (owners.length === 0) {
          unownedPaths.add(file);
          continue;
        }
        for (const owner of owners) {
          components.add(owner.id);
          for (const lane of owner.lanes) select(lane, `${owner.id}: ${file}`);
        }
      }
    }
  }

  if (!full && changes.length === 0) select("policy", "empty diff safety check");

  return {
    version: 2,
    base,
    head,
    full,
    changes,
    components: [...components].sort(),
    unownedPaths: [...unownedPaths].sort(),
    lanes,
  };
}

export function assertRequiredLaneResults({ planResult, selections, results }) {
  const failures = [];
  if (planResult !== "success") failures.push(`ci-plan: expected success, received ${planResult}`);
  for (const lane of CI_LANES) {
    const selected = selections[lane];
    const result = results[lane] ?? "missing";
    if (typeof selected !== "boolean") failures.push(`${lane}: selection must be boolean`);
    else if (selected && result !== "success") failures.push(`${lane}: expected success, received ${result}`);
    else if (!selected && result !== "skipped") failures.push(`${lane}: expected skipped, received ${result}`);
  }
  if (failures.length) throw new Error(`Required CI lane mismatch:\n${failures.join("\n")}`);
}
