import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_CORE_MANIFEST_VERSION,
  LOCAL_CORE_SCHEMA_VERSION,
  type LocalCoreDatabaseMode,
  type LocalCoreManifest,
} from "./contracts.js";
import { resolveLocalCorePaths } from "./home.js";

export async function readCoreManifest(homePath: string): Promise<LocalCoreManifest | undefined> {
  const paths = resolveLocalCorePaths(homePath);
  try {
    return parseCoreManifest(JSON.parse(await readFile(paths.manifestPath, "utf8")), homePath);
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
  dbMode?: LocalCoreDatabaseMode | undefined;
  capabilities?: string[] | undefined;
  schemaVersion?: number | undefined;
  now?: Date | undefined;
}): LocalCoreManifest {
  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    version: LOCAL_CORE_MANIFEST_VERSION,
    coreVersion: input.coreVersion,
    schemaVersion: input.schemaVersion ?? LOCAL_CORE_SCHEMA_VERSION,
    homePath: input.homePath,
    dbMode: input.dbMode ?? "managed",
    capabilities: [...(input.capabilities ?? [])].sort(),
    paths: resolveLocalCorePaths(input.homePath),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function parseCoreManifest(value: unknown, expectedHomePath: string): LocalCoreManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Kestrel Local Core manifest must be an object.");
  }
  const record = value as Partial<LocalCoreManifest>;
  if (record.version !== LOCAL_CORE_MANIFEST_VERSION) {
    throw new Error(`Unsupported Kestrel Local Core manifest version '${String(record.version)}'.`);
  }
  if (typeof record.coreVersion !== "string" || record.coreVersion.trim().length === 0) {
    throw new Error("Kestrel Local Core manifest coreVersion is required.");
  }
  if (typeof record.schemaVersion !== "number" || Number.isInteger(record.schemaVersion) === false) {
    throw new Error("Kestrel Local Core manifest schemaVersion is required.");
  }
  if (record.homePath !== expectedHomePath) {
    throw new Error("Kestrel Local Core manifest homePath does not match the active Core home.");
  }
  if (record.dbMode !== "managed" && record.dbMode !== "external" && record.dbMode !== "unavailable") {
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
    coreVersion: record.coreVersion,
    schemaVersion: record.schemaVersion,
    homePath: record.homePath,
    dbMode: record.dbMode,
    capabilities: record.capabilities,
    paths: resolveLocalCorePaths(expectedHomePath),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
