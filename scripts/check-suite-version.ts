import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

interface PackageManifest {
  dependencies?: Record<string, string>;
  name?: string;
  version?: string;
}

interface WorkspaceDefinition {
  packages?: string[];
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const rootManifest = readManifest("package.json");
const suiteVersion = requireNumericVersion(rootManifest.version, "root package.json");

const workspaceDefinition = parse(
  readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
) as WorkspaceDefinition;
const workspacePatterns = workspaceDefinition.packages ?? [];
assert.ok(workspacePatterns.length > 0, "pnpm-workspace.yaml must declare workspaces");

const workspaceManifestPaths = workspacePatterns.flatMap(expandWorkspacePattern);
assert.equal(
  new Set(workspaceManifestPaths).size,
  workspaceManifestPaths.length,
  "pnpm-workspace.yaml resolves a workspace more than once",
);

for (const manifestPath of ["package.json", ...workspaceManifestPaths]) {
  const manifest = readManifest(manifestPath);
  assert.ok(manifest.name, `${manifestPath} must declare a package name`);
  assert.equal(
    manifest.version,
    suiteVersion,
    `${manifest.name} must use the canonical suite version ${suiteVersion}`,
  );
}

const publicPackageNames = [
  "@kestrel-agents/kestrel",
  "@kestrel-agents/protocol",
  "@kestrel-agents/sdk",
  "@kestrel-agents/memory",
  "@kestrel-agents/next",
  "@kestrel-agents/ai-sdk",
  "@kestrel-agents/observability",
  "@kestrel-agents/workspace-skills",
] as const;

const kestrelOne = readManifest("apps/web/package.json");
requireNumericVersion(kestrelOne.version, "Kestrel One package.json");
const kestrelOnePackageDependencies = [
  "@kestrel-agents/protocol",
  "@kestrel-agents/sdk",
  "@kestrel-agents/memory",
  "@kestrel-agents/next",
  "@kestrel-agents/ai-sdk",
  "@kestrel-agents/workspace-skills",
] as const;
for (const packageName of kestrelOnePackageDependencies) {
  assert.equal(
    kestrelOne.dependencies?.[packageName],
    suiteVersion,
    `Kestrel One must depend on ${packageName}@${suiteVersion}`,
  );
}

const releaseModuleUrl = pathToFileURL(
  path.join(repoRoot, "apps/docs/lib/release.ts"),
).href;
const { DOCS_RELEASE } = (await import(releaseModuleUrl)) as {
  DOCS_RELEASE: {
    compatibility: ReadonlyArray<{ surface: string; version: string }>;
    packages: { releasedPackageNames: readonly string[]; version: string };
    products: Record<string, { version: string }>;
  };
};

assert.equal(
  DOCS_RELEASE.packages.version,
  suiteVersion,
  "docs package release metadata must match the canonical suite version",
);
assert.deepEqual(
  [...DOCS_RELEASE.packages.releasedPackageNames],
  [...publicPackageNames],
  "docs must enumerate the eight public packages in release order",
);
for (const [productName, product] of Object.entries(DOCS_RELEASE.products)) {
  assert.equal(
    product.version,
    suiteVersion,
    `docs product '${productName}' must match the canonical suite version`,
  );
}
for (const row of DOCS_RELEASE.compatibility) {
  assert.equal(
    row.version,
    suiteVersion,
    `docs compatibility row '${row.surface}' must match the canonical suite version`,
  );
}

console.log(
  `suite version check passed (${suiteVersion}; ${workspaceManifestPaths.length + 1} manifests; ${publicPackageNames.length} public packages)`,
);

function expandWorkspacePattern(pattern: string): string[] {
  const match = /^([^*]+)\/\*$/u.exec(pattern);
  assert.ok(
    match,
    `unsupported workspace pattern '${pattern}'; version enforcement requires explicit <directory>/* patterns`,
  );
  const directory = match[1];
  return readdirSync(path.join(repoRoot, directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join(directory, entry.name, "package.json"))
    .filter((manifestPath) => {
      try {
        readFileSync(path.join(repoRoot, manifestPath));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function readManifest(relativePath: string): PackageManifest {
  return JSON.parse(
    readFileSync(path.join(repoRoot, relativePath), "utf8"),
  ) as PackageManifest;
}

function requireNumericVersion(
  version: string | undefined,
  source: string,
): string {
  assert.match(
    version ?? "",
    /^\d+\.\d+\.\d+$/u,
    `${source} must declare a numeric product version`,
  );
  return version as string;
}
