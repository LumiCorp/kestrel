import { homedir } from "node:os";
import path from "node:path";
import type {
  KestrelCoreHomeResolution,
  LocalCorePaths,
} from "./contracts.js";
import { LOCAL_CORE_STATE_EPOCH } from "./constants.js";

export function resolveKestrelCoreHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): KestrelCoreHomeResolution {
  const explicitCoreHome = normalizeString(env.KESTREL_CORE_HOME);
  if (explicitCoreHome !== undefined) {
    return createHomeResolution({
      candidatePath: resolvePathWithHome(explicitCoreHome),
      source: "explicit_core_home",
      isolated: false,
      platform,
    });
  }

  const isolatedHome = normalizeString(env.KESTREL_HOME);
  if (isolatedHome !== undefined) {
    return createHomeResolution({
      candidatePath: resolvePathWithHome(isolatedHome),
      source: "isolated_dev_home",
      isolated: true,
      platform,
    });
  }

  return createHomeResolution({
    candidatePath: defaultCoreProductRootPath(platform),
    source: "default",
    isolated: false,
    platform,
  });
}

export function resolveLocalCorePaths(homePath: string): LocalCorePaths {
  const { productRootPath, stateRootPath } = resolveStateLocation(homePath);
  const corePath = path.join(stateRootPath, "core");
  const postgresPath = path.join(corePath, "postgres");
  const runtimePath = path.join(corePath, "runtime");
  return {
    productRootPath,
    stateRootPath,
    corePath,
    manifestPath: path.join(corePath, "manifest.json"),
    lockPath: path.join(corePath, "lock.json"),
    migrationLockPath: path.join(corePath, "migration.lock.json"),
    apiSocketPath: path.join(corePath, "api.sock"),
    apiTokenPath: path.join(corePath, "api.token"),
    runtimePath,
    settingsPath: path.join(stateRootPath, "settings"),
    workspaceRegistryPath: path.join(stateRootPath, "workspaces"),
    logsPath: path.join(corePath, "logs"),
    diagnosticsPath: path.join(stateRootPath, "diagnostics"),
    pgliteDataPath: path.join(corePath, "database", "pglite"),
    postgresDataPath: path.join(postgresPath, "data"),
    postgresSocketPath: path.join(postgresPath, "socket"),
    postgresMetadataPath: path.join(postgresPath, "metadata.json"),
    postgresLogPath: path.join(corePath, "logs", "postgres.log"),
  };
}

function createHomeResolution(input: {
  candidatePath: string;
  source: KestrelCoreHomeResolution["source"];
  isolated: boolean;
  platform: NodeJS.Platform;
}): KestrelCoreHomeResolution {
  const location = resolveStateLocation(input.candidatePath);
  return {
    productRootPath: location.productRootPath,
    homePath: location.stateRootPath,
    stateEpoch: LOCAL_CORE_STATE_EPOCH,
    source: input.source,
    isolated: input.isolated,
    platform: input.platform,
  };
}

function resolveStateLocation(candidatePath: string): {
  productRootPath: string;
  stateRootPath: string;
} {
  const resolvedPath = path.resolve(candidatePath);
  const parentPath = path.dirname(resolvedPath);
  const isCanonicalStateRoot = path.basename(resolvedPath) === LOCAL_CORE_STATE_EPOCH
    && path.basename(parentPath) === "state";
  if (isCanonicalStateRoot) {
    return {
      productRootPath: path.dirname(parentPath),
      stateRootPath: resolvedPath,
    };
  }
  return {
    productRootPath: resolvedPath,
    stateRootPath: path.join(resolvedPath, "state", LOCAL_CORE_STATE_EPOCH),
  };
}

function defaultCoreProductRootPath(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Kestrel");
  }
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "Kestrel");
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "kestrel");
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolvePathWithHome(candidate: string): string {
  if (candidate === "~") {
    return homedir();
  }
  if (candidate.startsWith("~/")) {
    return path.join(homedir(), candidate.slice(2));
  }
  return path.resolve(candidate);
}
