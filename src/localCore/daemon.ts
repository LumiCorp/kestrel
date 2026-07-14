import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  EnsureLocalCoreReadyOptions,
  LocalCoreStatus,
} from "./contracts.js";
import { LocalCoreClient } from "./client.js";
import {
  createLocalCoreConnectionDescriptor,
  type LocalCoreConnectionDescriptor,
} from "./connection.js";
import { resolveKestrelCoreHome, resolveLocalCorePaths } from "./home.js";
import { readCoreLock } from "./lock.js";
import { ensureLocalCoreReady } from "./ready.js";

export interface LocalCoreDaemonReady {
  status: LocalCoreStatus;
  client?: LocalCoreClient | undefined;
  connection?: LocalCoreConnectionDescriptor | undefined;
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

  const spawned = spawnDaemon({
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
    logPath: path.join(paths.logsPath, "local-core-daemon.log"),
  });

  const started = await waitForDaemon({
    socketPath: paths.apiSocketPath,
    tokenPath: paths.apiTokenPath,
    timeoutMs: options.waitTimeoutMs ?? 30_000,
    intervalMs: options.probeIntervalMs ?? 250,
    spawned,
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
}): Promise<{
  status: LocalCoreStatus;
  client: LocalCoreClient;
  connection: LocalCoreConnectionDescriptor;
} | undefined> {
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
    const connection = createLocalCoreConnectionDescriptor({ socketPath, authToken: token });
    const client = new LocalCoreClient({
      socketPath: connection.socketPath,
      token: connection.authToken,
      timeoutMs: 2_000,
    });
    const status = await client.status();
    return { status, client, connection };
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
  logPath: string;
}): SpawnedLocalCoreDaemon {
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
  mkdirSync(path.dirname(input.logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(input.logPath, "a", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ["--import", runtime.tsxImport, runtime.entrypoint], {
      cwd: runtime.cwd,
      env: childEnv,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  let startupFailure: Error | undefined;
  child.once("error", (error) => {
    startupFailure = error;
  });
  child.once("exit", (code, signal) => {
    startupFailure ??= new Error(
      `Kestrel Local Core daemon exited before readiness (code=${code ?? "none"}, signal=${signal ?? "none"}).`,
    );
  });
  child.unref();
  return {
    logPath: input.logPath,
    readStartupFailure: () => startupFailure,
  };
}

interface SpawnedLocalCoreDaemon {
  logPath: string;
  readStartupFailure(): Error | undefined;
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
  spawned: SpawnedLocalCoreDaemon;
}): Promise<{
  status: LocalCoreStatus;
  client: LocalCoreClient;
  connection: LocalCoreConnectionDescriptor;
}> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < input.timeoutMs) {
    const startupFailure = input.spawned.readStartupFailure();
    if (startupFailure !== undefined) {
      throw new Error(
        `${startupFailure.message} See ${input.spawned.logPath} for daemon output.`,
        { cause: startupFailure },
      );
    }
    try {
      const token = (await readFile(input.tokenPath, "utf8")).trim();
      const connection = createLocalCoreConnectionDescriptor({
        socketPath: input.socketPath,
        authToken: token,
      });
      const client = new LocalCoreClient({
        socketPath: connection.socketPath,
        token: connection.authToken,
        timeoutMs: 2_000,
      });
      const status = await client.status();
      return { status, client, connection };
    } catch (error) {
      lastError = error;
      await sleep(input.intervalMs);
    }
  }
  throw new Error(
    `Kestrel Local Core daemon did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}. See ${input.spawned.logPath} for daemon output.`,
  );
}

function resolveDaemonRuntime(env: NodeJS.ProcessEnv): { entrypoint: string; tsxImport: string; cwd: string } {
  const libexecRoot = normalizeString(env.KESTREL_CLI_LIBEXEC);
  const entrypoint = resolveLocalCoreDaemonEntrypoint({ env });
  const requireRoot = libexecRoot ?? path.dirname(fileURLToPath(import.meta.url));
  const require = createRequire(path.join(requireRoot, "package.json"));
  return {
    entrypoint,
    tsxImport: require.resolve("tsx"),
    cwd: libexecRoot ?? process.cwd(),
  };
}

export function resolveLocalCoreDaemonEntrypoint(input: {
  env?: NodeJS.ProcessEnv | undefined;
  moduleUrl?: string | undefined;
  fileExists?: ((filePath: string) => boolean) | undefined;
} = {}): string {
  const env = input.env ?? process.env;
  const explicitEntrypoint = normalizeString(env.KESTREL_LOCAL_CORE_DAEMON_ENTRYPOINT);
  if (explicitEntrypoint !== undefined) {
    return explicitEntrypoint;
  }
  const libexecRoot = normalizeString(env.KESTREL_CLI_LIBEXEC);
  if (libexecRoot !== undefined) {
    return path.join(libexecRoot, "src", "localCore", "daemonMain.ts");
  }

  const moduleUrl = input.moduleUrl ?? import.meta.url;
  const compiledEntrypoint = fileURLToPath(new URL("./daemonMain.js", moduleUrl));
  if ((input.fileExists ?? existsSync)(compiledEntrypoint)) {
    return compiledEntrypoint;
  }
  return fileURLToPath(new URL("./daemonMain.ts", moduleUrl));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
