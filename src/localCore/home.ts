import { homedir } from "node:os";
import path from "node:path";
import type { KestrelCoreHomeResolution, LocalCorePaths } from "./contracts.js";

export function resolveKestrelCoreHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): KestrelCoreHomeResolution {
  const explicitCoreHome = normalizeString(env.KESTREL_CORE_HOME);
  if (explicitCoreHome !== undefined) {
    return {
      homePath: resolvePathWithHome(explicitCoreHome),
      source: "explicit_core_home",
      isolated: false,
      platform,
    };
  }

  const isolatedHome = normalizeString(env.KESTREL_HOME);
  if (isolatedHome !== undefined) {
    return {
      homePath: resolvePathWithHome(isolatedHome),
      source: "isolated_dev_home",
      isolated: true,
      platform,
    };
  }

  return {
    homePath: defaultCoreHomePath(platform),
    source: "default",
    isolated: false,
    platform,
  };
}

export function resolveLocalCorePaths(homePath: string): LocalCorePaths {
  const corePath = path.join(homePath, "core");
  const postgresPath = path.join(corePath, "postgres");
  return {
    corePath,
    manifestPath: path.join(corePath, "manifest.json"),
    lockPath: path.join(corePath, "lock.json"),
    migrationLockPath: path.join(corePath, "migration.lock.json"),
    apiSocketPath: path.join(corePath, "api.sock"),
    apiTokenPath: path.join(corePath, "api.token"),
    runtimePath: path.join(corePath, "runtime"),
    settingsPath: path.join(homePath, "settings"),
    workspaceRegistryPath: path.join(homePath, "workspaces"),
    logsPath: path.join(corePath, "logs"),
    diagnosticsPath: path.join(homePath, "diagnostics"),
    postgresDataPath: path.join(postgresPath, "data"),
    postgresSocketPath: path.join(postgresPath, "socket"),
    postgresMetadataPath: path.join(postgresPath, "metadata.json"),
    postgresLogPath: path.join(corePath, "logs", "postgres.log"),
  };
}

function defaultCoreHomePath(platform: NodeJS.Platform): string {
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
