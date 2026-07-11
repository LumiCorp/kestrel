import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoExternalDarwinDependencies,
  bundleDarwinDependencies,
} from "./darwin-dependency-bundle.js";

export interface PrepareDesktopPostgresBundleResult {
  prepared: boolean;
  targetRoot: string;
  reason?: string | undefined;
}

export interface DesktopPostgresBundleManifest {
  bundleFormatVersion: 2;
  version: string;
  platform: string;
  arch: string;
  selfContained: true;
  bundledLibraries: string[];
  scannedBinaries: number;
  preparedAt: string;
}

const REQUIRED_POSTGRES_BINARIES = ["initdb", "postgres", "pg_ctl", "createdb"] as const;
const MANIFEST_KEYS = [
  "arch",
  "bundleFormatVersion",
  "bundledLibraries",
  "platform",
  "preparedAt",
  "scannedBinaries",
  "selfContained",
  "version",
] as const;

if (isDirectExecution()) {
  const result = prepareDesktopPostgresBundle({
    repoRoot: resolveRepoRoot(process.cwd()),
  });
  if (result.prepared) {
    console.log(`[desktop] prepared bundled postgres in ${result.targetRoot}`);
  } else {
    console.warn(`[desktop] skipped bundled postgres: ${result.reason ?? "unavailable"}`);
  }
}

export function prepareDesktopPostgresBundle(input: {
  repoRoot: string;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  pgConfigPath?: string | undefined;
  strict?: boolean | undefined;
}): PrepareDesktopPostgresBundleResult {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const bundleRoot = path.join(input.repoRoot, "apps", "desktop", "resources", "postgres-bundle");
  const targetRoot = path.join(bundleRoot, `${platform}-${arch}`);

  if (platform !== "darwin") {
    return {
      prepared: false,
      targetRoot,
      reason: `platform '${platform}' is not supported for bundled desktop Postgres yet`,
    };
  }

  const pgConfigPath = input.pgConfigPath?.trim() || process.env.KESTREL_DESKTOP_PG_CONFIG?.trim() || "pg_config";
  let bindir: string;
  let libdir: string;
  let sharedir: string;
  let version: string;
  try {
    bindir = queryPgConfig(pgConfigPath, "--bindir");
    libdir = queryPgConfig(pgConfigPath, "--libdir");
    sharedir = queryPgConfig(pgConfigPath, "--sharedir");
    version = queryPgConfig(pgConfigPath, "--version");
  } catch (error) {
    if (input.strict === true) {
      throw error;
    }
    return {
      prepared: false,
      targetRoot,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  copyDirectoryContents(bindir, path.join(targetRoot, "bin"));
  copyDirectoryContents(libdir, path.join(targetRoot, "lib"));
  copyDirectoryContents(sharedir, path.join(targetRoot, "share"));
  removePostgresDevelopmentArtifacts(path.join(targetRoot, "lib"));
  makeTreeOwnerWritable(targetRoot);
  const dependencies = bundleDarwinDependencies({
    bundleLibDir: path.join(targetRoot, "lib"),
    sourceExecutableDir: bindir,
    sourceMappings: [
      { sourceRoot: bindir, targetRoot: path.join(targetRoot, "bin") },
      { sourceRoot: libdir, targetRoot: path.join(targetRoot, "lib") },
    ],
  });

  const requiredPaths = REQUIRED_POSTGRES_BINARIES.map((binary) =>
    path.join(targetRoot, "bin", binary)
  );
  for (const requiredPath of requiredPaths) {
    if (existsSync(requiredPath) === false) {
      throw new Error(`Bundled Postgres copy is incomplete; missing '${requiredPath}'.`);
    }
  }

  writeFileSync(
    path.join(targetRoot, "manifest.json"),
    `${JSON.stringify(
      {
        bundleFormatVersion: 2,
        version,
        platform,
        arch,
        selfContained: true,
        bundledLibraries: dependencies.bundledLibraries,
        scannedBinaries: dependencies.scannedBinaries,
        preparedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    prepared: true,
    targetRoot,
  };
}

export function verifyPreparedDesktopPostgresBundle(input: {
  targetRoot: string;
  expectedPlatform: string;
  expectedArch: string;
}): DesktopPostgresBundleManifest {
  const targetRoot = path.resolve(input.targetRoot);
  const manifestPath = path.join(targetRoot, "manifest.json");
  if (existsSync(manifestPath) === false) {
    throw new Error(`Prepared Desktop Postgres manifest is missing at '${manifestPath}'.`);
  }

  const manifest = readDesktopPostgresBundleManifest(manifestPath);
  const errors: string[] = [];
  if (manifest.platform !== input.expectedPlatform) {
    errors.push(
      `manifest platform '${manifest.platform}' does not match '${input.expectedPlatform}'`,
    );
  }
  if (manifest.arch !== input.expectedArch) {
    errors.push(`manifest arch '${manifest.arch}' does not match '${input.expectedArch}'`);
  }

  for (const binary of REQUIRED_POSTGRES_BINARIES) {
    const binaryPath = path.join(targetRoot, "bin", binary);
    if (existsSync(binaryPath) === false) {
      errors.push(`missing required executable '${binaryPath}'`);
      continue;
    }
    if ((statSync(binaryPath).mode & 0o111) === 0) {
      errors.push(`required executable is not executable: '${binaryPath}'`);
    }
  }

  for (const forbiddenPath of [
    path.join(targetRoot, "lib", "pgxs"),
    path.join(targetRoot, "lib", "pkgconfig"),
  ]) {
    if (existsSync(forbiddenPath)) {
      errors.push(`compile-only Postgres artifact is present: '${forbiddenPath}'`);
    }
  }

  inspectPreparedBundleTree(targetRoot, errors);
  for (const library of manifest.bundledLibraries) {
    const libraryPath = path.join(targetRoot, "lib", library);
    if (existsSync(libraryPath) === false) {
      errors.push(`manifest library is missing from the bundle: '${libraryPath}'`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Prepared Desktop Postgres bundle is invalid:\n${errors.join("\n")}`);
  }

  const audit = assertNoExternalDarwinDependencies({
    binaryRoots: [path.join(targetRoot, "bin"), path.join(targetRoot, "lib")],
    bundleLibDir: path.join(targetRoot, "lib"),
  });
  if (audit.scannedBinaries !== manifest.scannedBinaries) {
    throw new Error(
      `Prepared Desktop Postgres manifest scannedBinaries mismatch: expected `
        + `${manifest.scannedBinaries}, audited ${audit.scannedBinaries}.`,
    );
  }

  return manifest;
}

function readDesktopPostgresBundleManifest(manifestPath: string): DesktopPostgresBundleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read prepared Desktop Postgres manifest '${manifestPath}': ${detail}`);
  }
  if (isRecord(parsed) === false) {
    throw new Error(`Prepared Desktop Postgres manifest '${manifestPath}' must be an object.`);
  }

  const errors: string[] = [];
  const allowedKeys = new Set<string>(MANIFEST_KEYS);
  for (const key of Object.keys(parsed)) {
    if (allowedKeys.has(key) === false) {
      errors.push(`unsupported manifest field '${key}'`);
    }
  }
  for (const key of MANIFEST_KEYS) {
    if (Object.hasOwn(parsed, key) === false) {
      errors.push(`missing manifest field '${key}'`);
    }
  }
  if (parsed.bundleFormatVersion !== 2) {
    errors.push("bundleFormatVersion must be 2");
  }
  if (parsed.selfContained !== true) {
    errors.push("selfContained must be true");
  }
  for (const key of ["version", "platform", "arch", "preparedAt"] as const) {
    if (typeof parsed[key] !== "string" || parsed[key].trim().length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  if (
    typeof parsed.scannedBinaries !== "number"
    || Number.isInteger(parsed.scannedBinaries) === false
    || parsed.scannedBinaries <= 0
  ) {
    errors.push("scannedBinaries must be a positive integer");
  }
  if (Array.isArray(parsed.bundledLibraries) === false) {
    errors.push("bundledLibraries must be an array");
  } else {
    const seenLibraries = new Set<string>();
    for (const library of parsed.bundledLibraries) {
      if (
        typeof library !== "string"
        || library.length === 0
        || path.posix.basename(library) !== library
        || path.win32.basename(library) !== library
      ) {
        errors.push(`bundledLibraries contains an invalid basename '${String(library)}'`);
        continue;
      }
      if (seenLibraries.has(library)) {
        errors.push(`bundledLibraries contains duplicate '${library}'`);
      }
      seenLibraries.add(library);
    }
  }
  for (const absolutePath of findAbsoluteManifestPaths(parsed)) {
    errors.push(`manifest contains build-machine path ${absolutePath}`);
  }
  if (errors.length > 0) {
    throw new Error(`Prepared Desktop Postgres manifest is invalid:\n${errors.join("\n")}`);
  }

  return parsed as unknown as DesktopPostgresBundleManifest;
}

function inspectPreparedBundleTree(entryPath: string, errors: string[]): void {
  const entryStat = lstatSync(entryPath);
  if (entryStat.isSymbolicLink()) {
    errors.push(`bundle contains a symbolic link: '${entryPath}'`);
    return;
  }
  if (entryStat.isDirectory()) {
    for (const entry of readdirSync(entryPath)) {
      inspectPreparedBundleTree(path.join(entryPath, entry), errors);
    }
    return;
  }
  if (entryPath.endsWith(".a")) {
    errors.push(`compile-only static library is present: '${entryPath}'`);
  }
}

function findAbsoluteManifestPaths(value: unknown, fieldPath = "manifest"): string[] {
  if (typeof value === "string") {
    return path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      ? [`${fieldPath}='${value}'`]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findAbsoluteManifestPaths(entry, `${fieldPath}[${index}]`)
    );
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) =>
      findAbsoluteManifestPaths(entry, `${fieldPath}.${key}`)
    );
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function removePostgresDevelopmentArtifacts(libRoot: string): void {
  rmSync(path.join(libRoot, "pgxs"), { recursive: true, force: true });
  rmSync(path.join(libRoot, "pkgconfig"), { recursive: true, force: true });
  removeFilesWithSuffix(libRoot, ".a");
}

function removeFilesWithSuffix(rootPath: string, suffix: string): void {
  if (existsSync(rootPath) === false) {
    return;
  }
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      removeFilesWithSuffix(entryPath, suffix);
    } else if (entry.name.endsWith(suffix)) {
      rmSync(entryPath, { force: true });
    }
  }
}

function queryPgConfig(command: string, flag: string): string {
  try {
    const value = execFileSync(command, [flag], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (value.length === 0) {
      throw new Error(`pg_config ${flag} returned an empty value.`);
    }
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to prepare bundled desktop Postgres via '${command} ${flag}': ${detail}`);
  }
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = path.join(sourceDir, entry);
    const targetPath = path.join(targetDir, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
    } else {
      copyFileSync(sourcePath, targetPath);
      chmodSync(targetPath, statSync(sourcePath).mode & 0o777);
    }
  }
}
function makeTreeOwnerWritable(entryPath: string): void {
  const entryStat = statSync(entryPath);
  chmodSync(entryPath, (entryStat.mode & 0o777) | 0o200);
  if (entryStat.isDirectory() === false) {
    return;
  }
  for (const entry of readdirSync(entryPath)) {
    makeTreeOwnerWritable(path.join(entryPath, entry));
  }
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) {
    return false;
  }
  return path.resolve(entryPath) === fileURLToPath(import.meta.url);
}
