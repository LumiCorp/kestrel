import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ensureLocalCoreDaemonReady } from "../src/localCore/daemon.js";
import type { LocalCoreClient } from "../src/localCore/client.js";
import type { LocalCoreStatus } from "../src/localCore/contracts.js";
import { parseLocalCorePlatform } from "../src/localCore/platform.js";
import { shouldKeepEnvironmentDatabaseUrl } from "./localCoreEnv.js";

export type CliLocalCoreStatus = LocalCoreStatus & {
  client?: LocalCoreClient | undefined;
};

export async function ensureCliLocalCoreReady(input: {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  ownerExecutable?: string | undefined;
} = {}): Promise<CliLocalCoreStatus> {
  const env = input.env ?? process.env;
  const ready = await ensureLocalCoreDaemonReady({
    env,
    platform:
      input.platform
      ?? parseLocalCorePlatform(env.KESTREL_CORE_PLATFORM)
      ?? process.platform,
    coreVersion: readCliSuiteVersion(),
    ownerExecutable: input.ownerExecutable ?? process.argv[1] ?? process.execPath,
    runMigrations: true,
    repoRoot: resolveCliRuntimeRoot(env),
    ...resolvePackagedCliPostgresBundle(env),
  });
  const status: CliLocalCoreStatus = Object.assign(ready.status, ready.client !== undefined ? { client: ready.client } : {});
  applyLocalCoreShellEnvironment(status, env, ready.client);
  return status;
}

export function applyLocalCoreShellEnvironment(
  status: LocalCoreStatus,
  env: NodeJS.ProcessEnv = process.env,
  client?: LocalCoreClient | undefined,
): void {
  if (status.home.source !== "isolated_dev_home") {
    env.KESTREL_CORE_HOME = status.home.homePath;
  }
  if (env.KESTREL_HOME === undefined || env.KESTREL_HOME.trim().length === 0) {
    env.KESTREL_HOME = status.home.homePath;
  }
  if (status.databaseUrl !== undefined && status.databaseUrl.trim().length > 0) {
    env.DATABASE_URL = status.databaseUrl;
    env.KESTREL_DATABASE_URL_SOURCE = status.dbMode === "external" ? "cli_external" : "local_core_managed";
  } else if (readEnvValue(env.DATABASE_URL).length === 0 || shouldKeepEnvironmentDatabaseUrl(env) === false) {
    delete env.DATABASE_URL;
    delete env.KESTREL_DATABASE_URL_SOURCE;
  }
  if (client !== undefined && status.lock.state === "live") {
    const socketPath = status.lock.lock.socketPath;
    if (socketPath !== undefined) {
      env.KESTREL_LOCAL_CORE_API_SOCKET = socketPath;
    }
    const token = readLocalCoreApiToken(status.home.homePath);
    if (token !== undefined) {
      env.KESTREL_LOCAL_CORE_API_TOKEN = token;
    }
  }
}

function readEnvValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function formatCliLocalCoreStatus(status: LocalCoreStatus): string {
  const manifest = status.manifest;
  const lock = status.lock;
  return [
    `Kestrel Local Core: ${status.state}`,
    `Summary: ${status.summary}`,
    `Home: ${status.home.homePath}`,
    `Home source: ${status.home.source}${status.home.isolated ? " (isolated/dev)" : ""}`,
    `Core version: ${manifest?.coreVersion ?? "unknown"}`,
    `Schema version: ${manifest?.schemaVersion ?? "unknown"}`,
    `Database mode: ${status.dbMode}`,
    `Lock: ${lock.state}`,
    ...(lock.state === "live" || lock.state === "stale" || lock.state === "incompatible"
      ? [
          `Lock owner: pid=${lock.lock.ownerPid} executable=${lock.lock.ownerExecutable}`,
          ...(lock.lock.socketPath !== undefined ? [`API socket: ${lock.lock.socketPath}`] : []),
          ...(lock.lock.databaseSocketPath !== undefined ? [`Database socket: ${lock.lock.databaseSocketPath}`] : []),
          ...(lock.reason !== undefined ? [`Lock detail: ${lock.reason}`] : []),
        ]
      : lock.state === "repair_required"
        ? [`Lock detail: ${lock.reason}`]
        : []),
    `Diagnostics: ${status.diagnosticsPath}`,
    `Logs: ${status.logsPath}`,
  ].join("\n") + "\n";
}

function readCliSuiteVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  return typeof manifest.version === "string" && manifest.version.trim().length > 0
    ? manifest.version
    : "unknown";
}

function resolvePackagedCliPostgresBundle(env: NodeJS.ProcessEnv): { postgresBundleRootPath: string } | Record<string, never> {
  const explicit = env.KESTREL_LOCAL_CORE_POSTGRES_BUNDLE?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return { postgresBundleRootPath: explicit };
  }

  const libexecRoot = env.KESTREL_CLI_LIBEXEC?.trim();
  if (libexecRoot === undefined || libexecRoot.length === 0) {
    return {};
  }

  const bundledPath = path.join(libexecRoot, "postgres-bundle");
  if (existsSync(bundledPath) === false) {
    return {};
  }
  return { postgresBundleRootPath: bundledPath };
}

function resolveCliRuntimeRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env.KESTREL_CORE_REPO_ROOT?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const libexecRoot = env.KESTREL_CLI_LIBEXEC?.trim();
  if (libexecRoot !== undefined && libexecRoot.length > 0) {
    return libexecRoot;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function readLocalCoreApiToken(homePath: string): string | undefined {
  const tokenPath = path.join(homePath, "core", "api.token");
  try {
    const token = readFileSync(tokenPath, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}
