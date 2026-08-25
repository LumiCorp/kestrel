import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { RUNTIME_WORKSPACE_PACKAGES } from "./runtimeWorkspacePackages.js";

import {
  LOCAL_CORE_BUILD_IDENTITY_VERSION,
  parseLocalCoreBuildIdentity,
  type LocalCoreBuildIdentityV1,
} from "./contracts.js";

export const LOCAL_CORE_BUILD_MANIFEST_NAME = "kestrel-core-build.json";
export const LOCAL_CORE_BUILD_INPUTS_VERSION = "local_core_build_inputs_v1";

/**
 * Explicit executable inputs shared by source-backed CLI, packaged CLI, and
 * Desktop Local Core. This list is intentionally conservative: changing any
 * shipped runtime input rotates the Core build identity.
 */
export const LOCAL_CORE_BUILD_INPUT_PATHS = [
  "agents",
  "bin",
  "cli",
  "db/migrations",
  "models",
  "scripts",
  "src",
  "tools",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "packages/protocol/package.json",
  "packages/protocol/dist",
  "packages/workspace-skills/package.json",
  "packages/workspace-skills/dist",
  "packages/memory/package.json",
  "packages/memory/dist",
  "packages/environment-auth/package.json",
  "packages/environment-auth/dist",
  "packages/mcp-security/package.json",
  "packages/mcp-security/src",
] as const;

const EXCLUDED_BASENAMES = new Set([
  ".env",
  ".cache",
  ".kestrel",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "test-results",
  "tsconfig.tsbuildinfo",
]);
const EXCLUDED_RUNTIME_PATHS = new Set([
  "cli/client/InProcessRunnerTransport.ts",
  "cli/client/RunnerProcess.ts",
  "cli/runner/main.ts",
]);
export function resolveLocalCoreBuildIdentity(input: {
  runtimeRoot: string;
  suiteVersion: string;
  sourceCommit?: string | undefined;
  manifestRequired?: boolean | undefined;
}): LocalCoreBuildIdentityV1 {
  const manifestPath = path.join(
    input.runtimeRoot,
    LOCAL_CORE_BUILD_MANIFEST_NAME,
  );
  if (existsSync(manifestPath)) {
    const identity = parseLocalCoreBuildIdentity(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    if (identity.suiteVersion !== input.suiteVersion) {
      throw new Error(
        `Local Core build manifest suite version ${identity.suiteVersion} does not match ${input.suiteVersion}.`,
      );
    }
    const preparedIdentity = createSourceLocalCoreBuildIdentity(input);
    if (preparedIdentity.buildId !== identity.buildId) {
      throw new Error(
        `Local Core build manifest ${identity.buildId} does not match prepared runtime ${preparedIdentity.buildId}.`,
      );
    }
    return identity;
  }
  if (input.manifestRequired === true) {
    throw new Error(
      `Packaged Local Core build manifest is missing from '${input.runtimeRoot}'.`,
    );
  }
  return createSourceLocalCoreBuildIdentity(input);
}

export function createSourceLocalCoreBuildIdentity(input: {
  runtimeRoot: string;
  suiteVersion: string;
  sourceCommit?: string | undefined;
}): LocalCoreBuildIdentityV1 {
  const entries = collectBuildInputEntries(input.runtimeRoot);
  const sourceCommit = normalizeSourceCommit(input.sourceCommit);
  const digest = createHash("sha256");
  digest.update(`${LOCAL_CORE_BUILD_INPUTS_VERSION}\0`);
  for (const entry of entries) {
    digest.update(`${entry.path}\0${entry.type}\0${entry.digest}\0`);
  }
  return {
    version: LOCAL_CORE_BUILD_IDENTITY_VERSION,
    buildId: `sha256:${digest.digest("hex")}`,
    suiteVersion: input.suiteVersion,
    source: "source_tree",
    ...(sourceCommit !== undefined ? { sourceCommit } : {}),
  };
}

export function writePackagedLocalCoreBuildIdentity(input: {
  sourceRoot: string;
  targetRoot: string;
  suiteVersion: string;
  sourceCommit?: string | undefined;
}): LocalCoreBuildIdentityV1 {
  const sourceIdentity = createSourceLocalCoreBuildIdentity({
    runtimeRoot: input.sourceRoot,
    suiteVersion: input.suiteVersion,
    ...(input.sourceCommit !== undefined
      ? { sourceCommit: input.sourceCommit }
      : {}),
  });
  const preparedIdentity = createSourceLocalCoreBuildIdentity({
    runtimeRoot: input.targetRoot,
    suiteVersion: input.suiteVersion,
    ...(input.sourceCommit !== undefined
      ? { sourceCommit: input.sourceCommit }
      : {}),
  });
  if (preparedIdentity.buildId !== sourceIdentity.buildId) {
    throw new Error(
      `Prepared Local Core runtime ${preparedIdentity.buildId} does not match source runtime ${sourceIdentity.buildId}.`,
    );
  }
  const packagedIdentity: LocalCoreBuildIdentityV1 = {
    ...sourceIdentity,
    source: "packaged_payload",
  };
  writeFileSync(
    path.join(input.targetRoot, LOCAL_CORE_BUILD_MANIFEST_NAME),
    `${JSON.stringify(packagedIdentity, null, 2)}\n`,
    "utf8",
  );
  return packagedIdentity;
}

/**
 * Copies the canonical logical runtime inputs without cache, environment, or
 * test-output drift. Packaged CLI and Desktop payloads retain these paths so
 * their embedded identity can be independently recomputed from the payload.
 */
export function copyLocalCoreBuildInputs(input: {
  sourceRoot: string;
  targetRoot: string;
}): void {
  const sourceRoot = path.resolve(input.sourceRoot);
  const targetRoot = path.resolve(input.targetRoot);
  for (const relativeInput of LOCAL_CORE_BUILD_INPUT_PATHS) {
    const sourcePath = path.join(sourceRoot, relativeInput);
    if (existsSync(sourcePath) === false) {
      throw new Error(
        `Local Core build input '${relativeInput}' is missing from '${sourceRoot}'.`,
      );
    }
    cpSync(sourcePath, path.join(targetRoot, relativeInput), {
      recursive: true,
      force: true,
      filter(candidate) {
        const resolvedCandidate = path.resolve(candidate);
        if (shouldExcludeRuntimePath(sourceRoot, resolvedCandidate))
          return false;
        return (
          resolvedCandidate === sourcePath ||
          shouldExcludeBuildInput(path.basename(resolvedCandidate)) === false
        );
      },
    });
  }
  for (const descriptor of RUNTIME_WORKSPACE_PACKAGES) {
    for (const relativePath of ["package.json", "dist"] as const) {
      const sourcePath = path.join(sourceRoot, descriptor.directory, relativePath);
      cpSync(
        sourcePath,
        path.join(targetRoot, descriptor.directory, relativePath),
        { recursive: true, force: true },
      );
    }
  }
}

/** Verifies the installed package code that the prepared runtime will import. */
export function verifyLocalCoreWorkspacePackagePayloads(input: {
  sourceRoot: string;
  dependencyRoot: string;
}): void {
  const dependencyManifestPath = path.join(input.dependencyRoot, "package.json");
  const declaredDependencies = existsSync(dependencyManifestPath)
    ? readDependencyNames(dependencyManifestPath)
    : new Set<string>();
  const installedDependencies = RUNTIME_WORKSPACE_PACKAGES.filter((dependency) =>
    declaredDependencies.has(dependency.name) ||
    existsSync(
      path.join(
        input.dependencyRoot,
        "node_modules",
        ...dependency.name.split("/"),
        "package.json",
      ),
    )
  );
  if (installedDependencies.length === 0) {
    throw new Error(
      `Prepared Local Core runtime '${input.dependencyRoot}' has no installed workspace dependencies.`,
    );
  }
  for (const dependency of installedDependencies) {
    const sourcePackageRoot = path.join(input.sourceRoot, dependency.directory);
    const installedPackageRoot = path.join(
      input.dependencyRoot,
      "node_modules",
      ...dependency.name.split("/"),
    );
    const sourceManifest = readPackageIdentity(
      path.join(sourcePackageRoot, "package.json"),
    );
    const installedManifest = readPackageIdentity(
      path.join(installedPackageRoot, "package.json"),
    );
    if (
      sourceManifest.name !== installedManifest.name ||
      sourceManifest.version !== installedManifest.version
    ) {
      throw new Error(
        `Installed Local Core dependency ${dependency.name} does not match its source package identity.`,
      );
    }
    const sourceEntries = collectTreeEntries(
      path.join(sourcePackageRoot, "dist"),
    );
    const installedEntries = collectTreeEntries(
      path.join(installedPackageRoot, "dist"),
    );
    if (JSON.stringify(installedEntries) !== JSON.stringify(sourceEntries)) {
      throw new Error(
        `Installed Local Core dependency ${dependency.name} does not match its built source payload.`,
      );
    }
  }
}

function readDependencyNames(manifestPath: string): Set<string> {
  const value = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: unknown;
  };
  if (
    typeof value.dependencies !== "object" ||
    value.dependencies === null ||
    Array.isArray(value.dependencies)
  ) {
    return new Set();
  }
  return new Set(Object.keys(value.dependencies));
}

interface BuildInputEntry {
  path: string;
  type: "file" | "symlink";
  digest: string;
}

function collectBuildInputEntries(runtimeRoot: string): BuildInputEntry[] {
  const root = path.resolve(runtimeRoot);
  const entries: BuildInputEntry[] = [];
  for (const relativeInput of LOCAL_CORE_BUILD_INPUT_PATHS) {
    const absoluteInput = path.join(root, relativeInput);
    if (existsSync(absoluteInput) === false) {
      throw new Error(
        `Local Core build input '${relativeInput}' is missing from '${root}'.`,
      );
    }
    collectPath(root, absoluteInput, entries, true);
  }
  entries.push(...collectRuntimeWorkspaceDependencyEntries(root));
  return entries.sort((left, right) =>
    compareCanonicalPaths(left.path, right.path),
  );
}

function collectRuntimeWorkspaceDependencyEntries(
  root: string,
): BuildInputEntry[] {
  const entries: BuildInputEntry[] = [];
  for (const descriptor of RUNTIME_WORKSPACE_PACKAGES) {
    const packageRoot = resolveRuntimeWorkspacePackageRoot(root, descriptor);
    const identity = readPackageIdentity(
      path.join(packageRoot, "package.json"),
    );
    if (identity.name !== descriptor.name) {
      throw new Error(
        `Local Core workspace package '${packageRoot}' must declare ${descriptor.name}.`,
      );
    }
    const virtualRoot = `virtual/runtime-workspace/${descriptor.name}`;
    entries.push({
      path: `${virtualRoot}/package.json`,
      type: "file",
      digest: createHash("sha256")
        .update(`${JSON.stringify(identity)}\n`)
        .digest("hex"),
    });
    for (const entry of collectTreeEntries(path.join(packageRoot, "dist"))) {
      entries.push({
        ...entry,
        path: `${virtualRoot}/dist/${entry.path}`,
      });
    }
  }
  return entries;
}

function collectTreeEntries(root: string): BuildInputEntry[] {
  if (existsSync(root) === false) {
    throw new Error(`Local Core runtime payload '${root}' is missing.`);
  }
  const entries: BuildInputEntry[] = [];
  collectPath(root, root, entries, true);
  return entries.sort((left, right) =>
    compareCanonicalPaths(left.path, right.path),
  );
}

function collectPath(
  root: string,
  absolutePath: string,
  entries: BuildInputEntry[],
  explicitRoot = false,
): void {
  if (shouldExcludeRuntimePath(root, absolutePath)) return;
  const basename = path.basename(absolutePath);
  if (explicitRoot === false && shouldExcludeBuildInput(basename)) return;
  const stat = lstatSync(absolutePath);
  if (stat.isDirectory()) {
    for (const child of readdirSync(absolutePath).sort()) {
      collectPath(root, path.join(absolutePath, child), entries, false);
    }
    return;
  }
  const relativePath = path
    .relative(root, absolutePath)
    .split(path.sep)
    .join("/");
  if (stat.isFile()) {
    entries.push({
      path: relativePath,
      type: "file",
      digest: createHash("sha256")
        .update(readBuildInputBytes(root, relativePath, absolutePath))
        .digest("hex"),
    });
    return;
  }
  if (stat.isSymbolicLink()) {
    entries.push({
      path: relativePath,
      type: "symlink",
      digest: createHash("sha256")
        .update(readlinkSync(absolutePath))
        .digest("hex"),
    });
    return;
  }
  throw new Error(`Unsupported Local Core build input '${relativePath}'.`);
}

function readBuildInputBytes(
  root: string,
  relativePath: string,
  absolutePath: string,
): Buffer {
  const sourceBytes = readFileSync(absolutePath);
  if (relativePath !== "package.json") return sourceBytes;

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(sourceBytes.toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("root package manifest must be an object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Local Core root package manifest '${absolutePath}' is invalid: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  const dependencies = manifest.dependencies;
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies)
  ) {
    throw new Error(
      `Local Core root package manifest '${absolutePath}' must declare dependencies.`,
    );
  }
  const dependencyRecord = dependencies as Record<string, unknown>;
  for (const descriptor of RUNTIME_WORKSPACE_PACKAGES) {
    const declared = dependencyRecord[descriptor.name];
    if (typeof declared !== "string" || declared.trim().length === 0) {
      throw new Error(
        `Local Core root package manifest must declare ${descriptor.name}.`,
      );
    }
    const packageRoot = resolveRuntimeWorkspacePackageRoot(root, descriptor);
    const identity = readPackageIdentity(
      path.join(packageRoot, "package.json"),
    );
    if (identity.name !== descriptor.name) {
      throw new Error(
        `Local Core workspace package '${packageRoot}' must declare ${descriptor.name}.`,
      );
    }
    if (declared.startsWith("workspace:")) {
      dependencyRecord[descriptor.name] = identity.version;
      continue;
    }
    if (
      descriptor.packedRuntimeRangePrefix.length > 0 &&
      declared === `${descriptor.packedRuntimeRangePrefix}${identity.version}`
    ) {
      dependencyRecord[descriptor.name] = identity.version;
      continue;
    }
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(declared)) {
      if (declared !== identity.version) {
        throw new Error(
          `Local Core dependency ${descriptor.name} pins ${declared}, but the resolved package is ${identity.version}.`,
        );
      }
      dependencyRecord[descriptor.name] = identity.version;
      continue;
    }
    throw new Error(
      `Local Core dependency ${descriptor.name} must use a workspace range, its canonical packed Runtime range, or the exact resolved version; found ${declared}.`,
    );
  }
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

function resolveRuntimeWorkspacePackageRoot(
  root: string,
  descriptor: (typeof RUNTIME_WORKSPACE_PACKAGES)[number],
): string {
  const installedRoot = path.join(
    root,
    "node_modules",
    ...descriptor.name.split("/"),
  );
  if (existsSync(path.join(installedRoot, "package.json")))
    return installedRoot;
  const sourceRoot = path.join(root, descriptor.directory);
  if (existsSync(path.join(sourceRoot, "package.json"))) return sourceRoot;
  let ancestor = path.dirname(root);
  while (ancestor !== path.dirname(ancestor)) {
    const ancestorInstalledRoot = path.join(
      ancestor,
      "node_modules",
      ...descriptor.name.split("/"),
    );
    if (existsSync(path.join(ancestorInstalledRoot, "package.json"))) {
      return ancestorInstalledRoot;
    }
    ancestor = path.dirname(ancestor);
  }
  throw new Error(
    `Local Core dependency ${descriptor.name} is missing from '${root}'.`,
  );
}

function shouldExcludeBuildInput(basename: string): boolean {
  return EXCLUDED_BASENAMES.has(basename) || basename.startsWith(".env.");
}

function shouldExcludeRuntimePath(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate).split(path.sep).join("/");
  return EXCLUDED_RUNTIME_PATHS.has(relativePath);
}

function compareCanonicalPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readPackageIdentity(manifestPath: string): {
  name: string;
  version: string;
} {
  const value = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    typeof value.version !== "string" ||
    value.version.trim().length === 0
  ) {
    throw new Error(
      `Local Core package manifest '${manifestPath}' is invalid.`,
    );
  }
  return { name: value.name.trim(), version: value.version.trim() };
}

function normalizeSourceCommit(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && /^[a-f0-9]{40}$/u.test(normalized)
    ? normalized
    : undefined;
}
