import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_CORE_MANIFEST_VERSION,
  LOCAL_CORE_SCHEMA_VERSION,
  LOCAL_CORE_STATE_EPOCH,
  type LocalCoreConfiguredDatabaseMode,
  type LocalCoreManifest,
} from "./contracts.js";
import { resolveLocalCorePaths } from "./home.js";

export async function readCoreManifest(homePath: string): Promise<LocalCoreManifest | undefined> {
  const paths = resolveLocalCorePaths(homePath);
  try {
    const manifest = parseCoreManifest(JSON.parse(await readFile(paths.manifestPath, "utf8")));
    const [manifestStateRoot, expectedStateRoot] = await Promise.all([
      realpath(manifest.homePath),
      realpath(paths.stateRootPath),
    ]);
    if (manifestStateRoot !== expectedStateRoot) {
      throw new Error("Kestrel Local Core manifest homePath does not match the active Core home.");
    }
    return {
      ...manifest,
      homePath: expectedStateRoot,
      paths: resolveLocalCorePaths(expectedStateRoot),
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function writeCoreManifest(homePath: string, manifest: LocalCoreManifest): Promise<void> {
  const paths = resolveLocalCorePaths(homePath);
  await mkdir(path.dirname(paths.manifestPath), { recursive: true });
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function createCoreManifest(input: {
  homePath: string;
  coreVersion: string;
  dbMode?: LocalCoreConfiguredDatabaseMode | undefined;
  capabilities?: string[] | undefined;
  schemaVersion?: number | undefined;
  now?: Date | undefined;
}): LocalCoreManifest {
  const timestamp = (input.now ?? new Date()).toISOString();
  const paths = resolveLocalCorePaths(input.homePath);
  return {
    version: LOCAL_CORE_MANIFEST_VERSION,
    stateEpoch: LOCAL_CORE_STATE_EPOCH,
    coreVersion: input.coreVersion,
    schemaVersion: input.schemaVersion ?? LOCAL_CORE_SCHEMA_VERSION,
    homePath: paths.stateRootPath,
    dbMode: input.dbMode ?? "pglite",
    capabilities: [...(input.capabilities ?? [])].sort(),
    paths,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function parseCoreManifest(value: unknown): LocalCoreManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Kestrel Local Core manifest must be an object.");
  }
  const record = value as Partial<LocalCoreManifest>;
  if (record.version !== LOCAL_CORE_MANIFEST_VERSION) {
    throw new Error(`Unsupported Kestrel Local Core manifest version '${String(record.version)}'.`);
  }
  if (typeof record.stateEpoch !== "string" || record.stateEpoch.trim().length === 0) {
    throw new Error("Kestrel Local Core manifest stateEpoch is required.");
  }
  if (typeof record.coreVersion !== "string" || record.coreVersion.trim().length === 0) {
    throw new Error("Kestrel Local Core manifest coreVersion is required.");
  }
  if (typeof record.schemaVersion !== "number" || Number.isInteger(record.schemaVersion) === false) {
    throw new Error("Kestrel Local Core manifest schemaVersion is required.");
  }
  if (typeof record.homePath !== "string" || record.homePath.trim().length === 0) {
    throw new Error("Kestrel Local Core manifest homePath is required.");
  }
  if (record.dbMode !== "pglite" && record.dbMode !== "external") {
    throw new Error("Kestrel Local Core manifest dbMode is invalid.");
  }
  if (Array.isArray(record.capabilities) === false || record.capabilities.some((item) => typeof item !== "string")) {
    throw new Error("Kestrel Local Core manifest capabilities must be a string array.");
  }
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
    throw new Error("Kestrel Local Core manifest timestamps are required.");
  }
  return {
    version: LOCAL_CORE_MANIFEST_VERSION,
    stateEpoch: record.stateEpoch,
    coreVersion: record.coreVersion,
    schemaVersion: record.schemaVersion,
    homePath: record.homePath,
    dbMode: record.dbMode,
    capabilities: record.capabilities,
    paths: resolveLocalCorePaths(record.homePath),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
