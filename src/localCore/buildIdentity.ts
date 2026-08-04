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
const PACKAGED_WORKSPACE_DEPENDENCIES = [
  {
    sourcePath: "packages/protocol",
    packageName: "@kestrel-agents/protocol",
  },
  {
    sourcePath: "packages/workspace-skills",
    packageName: "@kestrel-agents/workspace-skills",
  },
  {
    sourcePath: "packages/memory",
    packageName: "@kestrel-agents/memory",
  },
  {
    sourcePath: "packages/environment-auth",
    packageName: "@lumi/kestrel-environment-auth",
  },
] as const;

export function resolveLocalCoreBuildIdentity(input: {
  runtimeRoot: string;
  suiteVersion: string;
  sourceCommit?: string | undefined;
  manifestRequired?: boolean | undefined;
}): LocalCoreBuildIdentityV1 {
  const manifestPath = path.join(input.runtimeRoot, LOCAL_CORE_BUILD_MANIFEST_NAME);
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
    throw new Error(`Packaged Local Core build manifest is missing from '${input.runtimeRoot}'.`);
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
    ...(input.sourceCommit !== undefined ? { sourceCommit: input.sourceCommit } : {}),
  });
  const preparedIdentity = createSourceLocalCoreBuildIdentity({
    runtimeRoot: input.targetRoot,
    suiteVersion: input.suiteVersion,
    ...(input.sourceCommit !== undefined ? { sourceCommit: input.sourceCommit } : {}),
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
      throw new Error(`Local Core build input '${relativeInput}' is missing from '${sourceRoot}'.`);
    }
    cpSync(sourcePath, path.join(targetRoot, relativeInput), {
      recursive: true,
      force: true,
      filter(candidate) {
        const resolvedCandidate = path.resolve(candidate);
        if (shouldExcludeRuntimePath(sourceRoot, resolvedCandidate)) return false;
        return resolvedCandidate === sourcePath
          || shouldExcludeBuildInput(path.basename(resolvedCandidate)) === false;
      },
    });
  }
}

/** Verifies the installed package code that the prepared runtime will import. */
export function verifyLocalCoreWorkspacePackagePayloads(input: {
  sourceRoot: string;
  dependencyRoot: string;
}): void {
  for (const dependency of PACKAGED_WORKSPACE_DEPENDENCIES) {
    const sourcePackageRoot = path.join(input.sourceRoot, dependency.sourcePath);
    const installedPackageRoot = path.join(
      input.dependencyRoot,
      "node_modules",
      ...dependency.packageName.split("/"),
    );
    const sourceManifest = readPackageIdentity(path.join(sourcePackageRoot, "package.json"));
    const installedManifest = readPackageIdentity(path.join(installedPackageRoot, "package.json"));
    if (
      sourceManifest.name !== installedManifest.name
      || sourceManifest.version !== installedManifest.version
    ) {
      throw new Error(
        `Installed Local Core dependency ${dependency.packageName} does not match its source package identity.`,
      );
    }
    const sourceEntries = collectTreeEntries(path.join(sourcePackageRoot, "dist"));
    const installedEntries = collectTreeEntries(path.join(installedPackageRoot, "dist"));
    if (JSON.stringify(installedEntries) !== JSON.stringify(sourceEntries)) {
      throw new Error(
        `Installed Local Core dependency ${dependency.packageName} does not match its built source payload.`,
      );
    }
  }
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
      throw new Error(`Local Core build input '${relativeInput}' is missing from '${root}'.`);
    }
    collectPath(root, absoluteInput, entries, true);
  }
  return entries.sort((left, right) => compareCanonicalPaths(left.path, right.path));
}

function collectTreeEntries(root: string): BuildInputEntry[] {
  if (existsSync(root) === false) {
    throw new Error(`Local Core runtime payload '${root}' is missing.`);
  }
  const entries: BuildInputEntry[] = [];
  collectPath(root, root, entries, true);
  return entries.sort((left, right) => compareCanonicalPaths(left.path, right.path));
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
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  if (stat.isFile()) {
    entries.push({
      path: relativePath,
      type: "file",
      digest: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
    });
    return;
  }
  if (stat.isSymbolicLink()) {
    entries.push({
      path: relativePath,
      type: "symlink",
      digest: createHash("sha256").update(readlinkSync(absolutePath)).digest("hex"),
    });
    return;
  }
  throw new Error(`Unsupported Local Core build input '${relativePath}'.`);
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

function readPackageIdentity(manifestPath: string): { name: string; version: string } {
  const value = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    typeof value.name !== "string"
    || value.name.trim().length === 0
    || typeof value.version !== "string"
    || value.version.trim().length === 0
  ) {
    throw new Error(`Local Core package manifest '${manifestPath}' is invalid.`);
  }
  return { name: value.name.trim(), version: value.version.trim() };
}

function normalizeSourceCommit(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && /^[a-f0-9]{40}$/u.test(normalized)
    ? normalized
    : undefined;
}
