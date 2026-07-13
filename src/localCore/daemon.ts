import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EnsureLocalCoreReadyOptions, LocalCoreStatus } from "./contracts.js";
import { LocalCoreClient } from "./client.js";
import { resolveKestrelCoreHome, resolveLocalCorePaths } from "./home.js";
import { readCoreLock } from "./lock.js";
import { ensureLocalCoreReady } from "./ready.js";

export interface LocalCoreDaemonReady {
  status: LocalCoreStatus;
  client?: LocalCoreClient | undefined;
  daemonStarted: boolean;
}

export interface EnsureLocalCoreDaemonReadyOptions extends EnsureLocalCoreReadyOptions {
  waitTimeoutMs?: number | undefined;
  probeIntervalMs?: number | undefined;
}

export async function ensureLocalCoreDaemonReady(
  options: EnsureLocalCoreDaemonReadyOptions,
): Promise<LocalCoreDaemonReady> {
  const env = options.env ?? process.env;
  if (env.KESTREL_LOCAL_CORE_DIRECT === "1") {
    return {
      status: await ensureLocalCoreReady(options),
      daemonStarted: false,
    };
  }

  const home = resolveKestrelCoreHome(env, options.platform);
  const paths = resolveLocalCorePaths(home.homePath);
  const existing = await connectIfLive({
    homePath: home.homePath,
    coreVersion: options.coreVersion,
    socketPath: paths.apiSocketPath,
    tokenPath: paths.apiTokenPath,
    isPidAlive: options.isPidAlive,
  });
  if (existing !== undefined) {
    return {
      ...existing,
      daemonStarted: false,
    };
  }

  spawnDaemon({
    env,
    platform: options.platform,
    coreVersion: options.coreVersion,
    schemaVersion: options.schemaVersion,
    databaseMode: options.databaseMode,
    externalDatabaseUrl: options.externalDatabaseUrl,
    allowInheritedDatabaseUrl: options.allowInheritedDatabaseUrl,
    postgresBundleRootPath: options.postgresBundleRootPath,
    runMigrations: options.runMigrations,
    repoRoot: options.repoRoot,
  });

  const started = await waitForDaemon({
    socketPath: paths.apiSocketPath,
    tokenPath: paths.apiTokenPath,
    timeoutMs: options.waitTimeoutMs ?? 30_000,
    intervalMs: options.probeIntervalMs ?? 250,
  });
  return {
    ...started,
    daemonStarted: true,
  };
}

async function connectIfLive(input: {
  homePath: string;
  coreVersion: string;
  socketPath: string;
  tokenPath: string;
  isPidAlive?: ((pid: number) => boolean) | undefined;
}): Promise<{ status: LocalCoreStatus; client: LocalCoreClient } | undefined> {
  const lock = await readCoreLock({
    homePath: input.homePath,
    currentCoreVersion: input.coreVersion,
    isPidAlive: input.isPidAlive,
  });
  if (lock.state !== "live") {
    return undefined;
  }
  const socketPath = lock.lock.socketPath ?? input.socketPath;
  if (existsSync(socketPath) === false) {
    return undefined;
  }
  try {
    const token = (await readFile(input.tokenPath, "utf8")).trim();
    const client = new LocalCoreClient({ socketPath, token, timeoutMs: 2_000 });
    const status = await client.status();
    return { status, client };
  } catch {
    return undefined;
  }
}

function spawnDaemon(input: {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | undefined;
  coreVersion: string;
  schemaVersion?: number | undefined;
  databaseMode?: "pglite" | "managed" | "external" | undefined;
  externalDatabaseUrl?: string | undefined;
  allowInheritedDatabaseUrl?: boolean | undefined;
  postgresBundleRootPath?: string | undefined;
  runMigrations?: boolean | undefined;
  repoRoot?: string | undefined;
}): void {
  const runtime = resolveDaemonRuntime(input.env);
  const electronRunAsNode = resolveLocalCoreDaemonNodeMode();
  const childEnv = {
    ...input.env,
    ...(electronRunAsNode !== undefined ? { ELECTRON_RUN_AS_NODE: electronRunAsNode } : {}),
    KESTREL_LOCAL_CORE_DAEMON: "1",
    KESTREL_CORE_VERSION: input.coreVersion,
    ...(input.schemaVersion !== undefined ? { KESTREL_CORE_SCHEMA_VERSION: String(input.schemaVersion) } : {}),
    KESTREL_CORE_OWNER_EXECUTABLE: runtime.entrypoint,
    ...(input.platform !== undefined ? { KESTREL_CORE_PLATFORM: input.platform } : {}),
    ...(input.databaseMode !== undefined ? { KESTREL_CORE_DATABASE_MODE: input.databaseMode } : {}),
    ...(input.externalDatabaseUrl !== undefined ? { KESTREL_CORE_EXTERNAL_DATABASE_URL: input.externalDatabaseUrl } : {}),
    ...(input.allowInheritedDatabaseUrl === true ? { KESTREL_CORE_ALLOW_INHERITED_DATABASE_URL: "1" } : {}),
    ...(input.postgresBundleRootPath !== undefined ? { KESTREL_LOCAL_CORE_POSTGRES_BUNDLE: input.postgresBundleRootPath } : {}),
    ...(input.runMigrations === true ? { KESTREL_CORE_RUN_MIGRATIONS: "1" } : {}),
    ...(input.repoRoot !== undefined ? { KESTREL_CORE_REPO_ROOT: input.repoRoot } : {}),
  };
  const child = spawn(process.execPath, ["--import", runtime.tsxImport, runtime.entrypoint], {
    cwd: runtime.cwd,
    env: childEnv,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function resolveLocalCoreDaemonNodeMode(
  versions: { electron?: string | undefined } = process.versions as { electron?: string | undefined },
): "1" | undefined {
  return typeof versions.electron === "string" && versions.electron.trim().length > 0
    ? "1"
    : undefined;
}

export function isLocalCoreDaemonElectronAppLaunch(input: {
  env?: NodeJS.ProcessEnv | undefined;
  versions?: { electron?: string | undefined } | undefined;
} = {}): boolean {
  const env = input.env ?? process.env;
  const versions = input.versions ?? process.versions as { electron?: string | undefined };
  return env.KESTREL_LOCAL_CORE_DAEMON?.trim() === "1"
    && typeof versions.electron === "string"
    && versions.electron.trim().length > 0
    && env.ELECTRON_RUN_AS_NODE?.trim() !== "1";
}

async function waitForDaemon(input: {
  socketPath: string;
  tokenPath: string;
  timeoutMs: number;
  intervalMs: number;
}): Promise<{ status: LocalCoreStatus; client: LocalCoreClient }> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < input.timeoutMs) {
    try {
      const token = (await readFile(input.tokenPath, "utf8")).trim();
      const client = new LocalCoreClient({ socketPath: input.socketPath, token, timeoutMs: 2_000 });
      const status = await client.status();
      return { status, client };
    } catch (error) {
      lastError = error;
      await sleep(input.intervalMs);
    }
  }
  throw new Error(`Kestrel Local Core daemon did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function resolveDaemonRuntime(env: NodeJS.ProcessEnv): { entrypoint: string; tsxImport: string; cwd: string } {
  const explicitEntrypoint = normalizeString(env.KESTREL_LOCAL_CORE_DAEMON_ENTRYPOINT);
  const libexecRoot = normalizeString(env.KESTREL_CLI_LIBEXEC);
  const entrypoint = explicitEntrypoint
    ?? (libexecRoot !== undefined
      ? path.join(libexecRoot, "src", "localCore", "daemonMain.ts")
      : fileURLToPath(new URL("./daemonMain.ts", import.meta.url)));
  const requireRoot = libexecRoot ?? path.dirname(fileURLToPath(import.meta.url));
  const require = createRequire(path.join(requireRoot, "package.json"));
  return {
    entrypoint,
    tsxImport: require.resolve("tsx"),
    cwd: libexecRoot ?? process.cwd(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
