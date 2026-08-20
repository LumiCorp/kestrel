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

const manifestPaths = ["package.json", ...workspaceManifestPaths];
const manifests = new Map<string, PackageManifest>();
for (const manifestPath of manifestPaths) {
  const manifest = readManifest(manifestPath);
  assert.ok(manifest.name, `${manifestPath} must declare a package name`);
  requireNumericVersion(manifest.version, `${manifest.name} version`);
  assert.equal(manifests.has(manifest.name), false, `duplicate workspace package '${manifest.name}'`);
  manifests.set(manifest.name, manifest);
}

for (const [name, manifest] of manifests) {
  for (const [dependencyName, declaredVersion] of Object.entries(manifest.dependencies ?? {})) {
    const dependency = manifests.get(dependencyName);
    if (dependency === undefined || !/^\d+\.\d+\.\d+$/u.test(declaredVersion)) continue;
    assert.equal(
      declaredVersion,
      dependency.version,
      `${name} pins ${dependencyName}@${declaredVersion}, but its manifest is ${dependency.version}`,
    );
  }
}

const publicPackageNames = [
  "@kestrel-agents/kestrel",
  "@kestrel-agents/protocol",
  "@kestrel-agents/conversation",
  "@kestrel-agents/sdk",
  "@kestrel-agents/memory",
  "@kestrel-agents/next",
  "@kestrel-agents/ai-sdk",
  "@kestrel-agents/observability",
  "@kestrel-agents/workspace-skills",
] as const;

const releaseModuleUrl = pathToFileURL(
  path.join(repoRoot, "apps/docs/lib/release.ts"),
).href;
const { DOCS_RELEASE } = (await import(releaseModuleUrl)) as {
  DOCS_RELEASE: {
    compatibility: ReadonlyArray<{ surface: string; version: string }>;
    packages: {
      releasedPackageNames: readonly string[];
      versions: Record<string, string>;
    };
    products: Record<string, { npmVersion?: string; version: string }>;
  };
};

assert.deepEqual(
  [...DOCS_RELEASE.packages.releasedPackageNames],
  [...publicPackageNames],
  "docs must enumerate the nine public packages in release order",
);
for (const packageName of publicPackageNames) {
  const manifest = manifests.get(packageName);
  assert.ok(manifest, `missing public package manifest '${packageName}'`);
  assert.equal(
    DOCS_RELEASE.packages.versions[packageName],
    manifest.version,
    `docs must report ${packageName}@${manifest.version}`,
  );
}

assert.equal(
  DOCS_RELEASE.products.cli.version,
  manifests.get("@kestrel-agents/kestrel")?.version,
  "docs CLI product version must match the Runtime package",
);
assert.equal(
  DOCS_RELEASE.products.cli.npmVersion,
  manifests.get("@kestrel-agents/kestrel")?.version,
  "docs CLI npm version must match the Runtime package",
);
assertProductVersion("desktop", "@kestrel/desktop");
assertProductVersion("kestrelOne", "@kestrel/kestrel-one");

const compatibilityOwners: Record<string, string> = {
  Runtime: "@kestrel-agents/kestrel",
  Protocol: "@kestrel-agents/protocol",
  Conversation: "@kestrel-agents/conversation",
  SDK: "@kestrel-agents/sdk",
  Memory: "@kestrel-agents/memory",
  "Next.js": "@kestrel-agents/next",
  "AI SDK": "@kestrel-agents/ai-sdk",
  Observability: "@kestrel-agents/observability",
  "Workspace skills": "@kestrel-agents/workspace-skills",
  CLI: "@kestrel-agents/kestrel",
  Desktop: "@kestrel/desktop",
  "Kestrel One": "@kestrel/kestrel-one",
};
for (const row of DOCS_RELEASE.compatibility) {
  const owner = compatibilityOwners[row.surface];
  assert.ok(owner, `docs compatibility surface '${row.surface}' has no owning artifact`);
  assert.equal(
    row.version,
    manifests.get(owner)?.version,
    `docs compatibility version for ${row.surface} must match ${owner}`,
  );
}
assert.deepEqual(
  DOCS_RELEASE.compatibility.map(({ surface }) => surface).sort(),
  Object.keys(compatibilityOwners).sort(),
  "docs compatibility must cover every release artifact exactly once",
);

console.log(
  `release artifact version check passed (${manifestPaths.length} manifests; ${publicPackageNames.length} public packages)`,
);

function assertProductVersion(productName: string, packageName: string): void {
  assert.equal(
    DOCS_RELEASE.products[productName]?.version,
    manifests.get(packageName)?.version,
    `docs ${productName} version must match ${packageName}`,
  );
}

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
