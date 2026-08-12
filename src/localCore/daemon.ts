import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  EnsureLocalCoreReadyOptions,
  LocalCoreBuildIdentityV1,
  LocalCoreLock,
  LocalCoreStatus,
  LocalCoreSystemLifecycle,
} from "./contracts.js";
import { LocalCoreApiError, LocalCoreClient } from "./client.js";
import { resolveLocalCoreBuildIdentity } from "./buildIdentity.js";
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
  buildIdentity?: LocalCoreBuildIdentityV1 | undefined;
  waitTimeoutMs?: number | undefined;
  probeIntervalMs?: number | undefined;
}

export type LocalCoreDaemonCompatibility =
  | "current"
  | "outdated"
  | "legacy"
  | "version_mismatch"
  | "unknown";

export interface LocalCoreDaemonInspection {
  state: "stopped" | "running" | "unreachable" | "repair_required";
  compatibility: LocalCoreDaemonCompatibility;
  expectedBuildIdentity: LocalCoreBuildIdentityV1;
  runningBuildIdentity?: LocalCoreBuildIdentityV1 | undefined;
  coreVersion?: string | undefined;
  ownerPid?: number | undefined;
  lifecycle?: LocalCoreSystemLifecycle | undefined;
  reason?: string | undefined;
}

export class LocalCoreBuildMismatchError extends Error {
  readonly inspection: LocalCoreDaemonInspection;

  constructor(inspection: LocalCoreDaemonInspection) {
    const blockers = inspection.lifecycle?.blockers.map((blocker) => blocker.message).join("; ");
    super(
      blockers
        ? `Local Core is running a different build and cannot restart while busy: ${blockers} Run 'kestrel core restart --wait' to wait safely.`
        : "Local Core is running a different build and could not be replaced safely.",
    );
    this.name = "LocalCoreBuildMismatchError";
    this.inspection = inspection;
  }
}

export class LocalCoreRestartBlockedError extends Error {
  readonly inspection: LocalCoreDaemonInspection;

  constructor(inspection: LocalCoreDaemonInspection) {
    super(
      `Local Core restart is blocked by active work: ${inspection.lifecycle?.blockers.map((blocker) => blocker.message).join("; ") || "lifecycle state is unavailable"}.`,
    );
    this.name = "LocalCoreRestartBlockedError";
    this.inspection = inspection;
  }
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
  const expectedBuildIdentity = options.buildIdentity ?? resolveExpectedBuildIdentity(options, env);
  let existing = await inspectWithExpected(options, expectedBuildIdentity);
  if (existing.inspection.state === "unreachable") {
    existing = await waitForInspectableAuthority({
      options,
      expectedBuildIdentity,
      timeoutMs: options.waitTimeoutMs ?? 30_000,
      intervalMs: options.probeIntervalMs ?? 250,
    });
  }
  if (existing.inspection.state === "running" && existing.inspection.compatibility === "current") {
    const status = await existing.client!.status();
    return {
      status,
      client: existing.client,
      connection: existing.connection,
      daemonStarted: false,
    };
  }
  if (existing.inspection.state === "running") {
    if (existing.inspection.lifecycle === undefined) {
      throw new Error(
        "The running Local Core cannot report lifecycle safety. Stop it manually before upgrading.",
      );
    }
    let shutdown: Awaited<ReturnType<LocalCoreClient["shutdownForCodeUpdate"]>> | undefined;
    try {
      shutdown = await requestCodeUpdateShutdown(
        existing.client!,
        existing.inspection.compatibility === "legacy",
      );
    } catch (error) {
      if (isAuthorityDisconnect(error) === false) throw error;
      // A concurrent launcher may have submitted the same graceful shutdown
      // after our inspection but before this request reached the old socket.
      // Treat that disconnect as handoff only after the inspected authority
      // actually releases ownership within the normal readiness bound.
      await waitForDaemonExit({
        homePath: home.homePath,
        ownerPid: existing.inspection.ownerPid,
        timeoutMs: options.waitTimeoutMs ?? 30_000,
        intervalMs: options.probeIntervalMs ?? 250,
        isPidAlive: options.isPidAlive,
      });
    }
    if (shutdown?.status === "blocked") {
      throw new LocalCoreBuildMismatchError({
        ...existing.inspection,
        lifecycle: shutdown.lifecycle,
      });
    }
    if (shutdown !== undefined) {
      await waitForDaemonExit({
        homePath: home.homePath,
        ownerPid: existing.inspection.ownerPid,
        timeoutMs: options.waitTimeoutMs ?? 30_000,
        intervalMs: options.probeIntervalMs ?? 250,
        isPidAlive: options.isPidAlive,
      });
    }
  } else if (
    existing.inspection.state === "unreachable"
    || existing.inspection.state === "repair_required"
  ) {
    throw new Error(existing.inspection.reason ?? "Kestrel Local Core requires repair before it can start.");
  }

  const spawned = spawnDaemon({
    env,
    platform: options.platform,
    coreVersion: options.coreVersion,
    buildIdentity: expectedBuildIdentity,
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
    homePath: home.homePath,
    timeoutMs: options.waitTimeoutMs ?? 30_000,
    intervalMs: options.probeIntervalMs ?? 250,
    spawned,
    expectedBuildIdentity,
    isPidAlive: options.isPidAlive,
  });
  return {
    ...started,
    daemonStarted: true,
  };
}

async function waitForInspectableAuthority(input: {
  options: EnsureLocalCoreDaemonReadyOptions;
  expectedBuildIdentity: LocalCoreBuildIdentityV1;
  timeoutMs: number;
  intervalMs: number;
}): Promise<InternalDaemonInspection> {
  const startedAt = Date.now();
  let inspected = await inspectWithExpected(
    input.options,
    input.expectedBuildIdentity,
  );
  while (
    inspected.inspection.state === "unreachable"
    && Date.now() - startedAt < input.timeoutMs
  ) {
    await sleep(input.intervalMs);
    inspected = await inspectWithExpected(
      input.options,
      input.expectedBuildIdentity,
    );
  }
  return inspected;
}

export async function inspectLocalCoreDaemon(
  options: EnsureLocalCoreDaemonReadyOptions,
): Promise<LocalCoreDaemonInspection> {
  const env = options.env ?? process.env;
  const expected = options.buildIdentity ?? resolveExpectedBuildIdentity(options, env);
  return (await inspectWithExpected(options, expected)).inspection;
}

export async function restartLocalCoreDaemon(
  options: EnsureLocalCoreDaemonReadyOptions & { waitForIdle?: boolean | undefined },
): Promise<LocalCoreDaemonReady> {
  const env = options.env ?? process.env;
  const expected = options.buildIdentity ?? resolveExpectedBuildIdentity(options, env);
  const home = resolveKestrelCoreHome(env, options.platform);
  const timeoutMs = options.waitTimeoutMs ?? 30_000;
  const intervalMs = options.probeIntervalMs ?? 250;
  while (true) {
    const current = await inspectWithExpected(options, expected);
    if (current.inspection.state === "stopped") break;
    if (current.inspection.state !== "running" || current.client === undefined) {
      throw new Error(current.inspection.reason ?? "Kestrel Local Core cannot be restarted safely.");
    }
    if (options.waitForIdle === true && current.inspection.lifecycle?.state === "busy") {
      await sleep(500);
      continue;
    }
    if (current.inspection.lifecycle === undefined) {
      throw new Error(
        "The running Local Core cannot report lifecycle safety. Stop it manually before upgrading.",
      );
    }
    const shutdown = await requestCodeUpdateShutdown(
      current.client,
      current.inspection.compatibility === "legacy",
    );
    if (shutdown.status === "accepted") {
      await waitForDaemonExit({
        homePath: home.homePath,
        ownerPid: current.inspection.ownerPid,
        timeoutMs,
        intervalMs,
        isPidAlive: options.isPidAlive,
      });
      break;
    }
    const blocked = { ...current.inspection, lifecycle: shutdown.lifecycle };
    if (options.waitForIdle !== true) {
      throw new LocalCoreRestartBlockedError(blocked);
    }
    await sleep(500);
  }
  return await ensureLocalCoreDaemonReady({ ...options, buildIdentity: expected });
}

interface InternalDaemonInspection {
  inspection: LocalCoreDaemonInspection;
  client?: LocalCoreClient | undefined;
  connection?: LocalCoreConnectionDescriptor | undefined;
}

async function inspectWithExpected(
  options: EnsureLocalCoreDaemonReadyOptions,
  expected: LocalCoreBuildIdentityV1,
): Promise<InternalDaemonInspection> {
  const env = options.env ?? process.env;
  const home = resolveKestrelCoreHome(env, options.platform);
  const paths = resolveLocalCorePaths(home.homePath);
  const lock = await readCoreLock({
    homePath: home.homePath,
    isPidAlive: options.isPidAlive,
  });
  if (lock.state === "missing" || lock.state === "stale") {
    return {
      inspection: {
        state: "stopped",
        compatibility: "unknown",
        expectedBuildIdentity: expected,
        ...(lock.state === "stale" ? { reason: lock.reason } : {}),
      },
    };
  }
  if (lock.state === "repair_required") {
    return {
      inspection: {
        state: "repair_required",
        compatibility: "unknown",
        expectedBuildIdentity: expected,
        reason: lock.reason,
      },
    };
  }
  const liveLock: LocalCoreLock = lock.lock;
  const socketPath = liveLock.socketPath ?? paths.apiSocketPath;
  try {
    const token = (await readFile(paths.apiTokenPath, "utf8")).trim();
    const connection = createLocalCoreConnectionDescriptor({ socketPath, authToken: token });
    const client = new LocalCoreClient({
      socketPath: connection.socketPath,
      token: connection.authToken,
      timeoutMs: 2000,
    });
    await client.health();
    let runningBuildIdentity: LocalCoreBuildIdentityV1 | undefined;
    try {
      runningBuildIdentity = await client.buildIdentity();
    } catch (error) {
      if (!(error instanceof LocalCoreApiError && error.statusCode === 404)) throw error;
    }
    const compatibility = classifyCompatibility(expected, liveLock, runningBuildIdentity);
    let lifecycle: LocalCoreSystemLifecycle | undefined;
    try {
      lifecycle = await client.systemLifecycle();
    } catch (error) {
      if (!(error instanceof LocalCoreApiError && error.statusCode === 404)) throw error;
    }
    return {
      inspection: inspectionFromLock("running", compatibility, expected, liveLock, {
        ...(runningBuildIdentity !== undefined ? { runningBuildIdentity } : {}),
        ...(lifecycle !== undefined ? { lifecycle } : {}),
      }),
      client,
      connection,
    };
  } catch (error) {
    return {
      inspection: inspectionFromLock("unreachable", "unknown", expected, liveLock, {
        reason: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

function inspectionFromLock(
  state: "running" | "unreachable",
  compatibility: LocalCoreDaemonCompatibility,
  expectedBuildIdentity: LocalCoreBuildIdentityV1,
  lock: LocalCoreLock,
  extra: Pick<LocalCoreDaemonInspection, "runningBuildIdentity" | "lifecycle" | "reason">,
): LocalCoreDaemonInspection {
  return {
    state,
    compatibility,
    expectedBuildIdentity,
    coreVersion: lock.coreVersion,
    ownerPid: lock.ownerPid,
    ...extra,
  };
}

function classifyCompatibility(
  expected: LocalCoreBuildIdentityV1,
  lock: LocalCoreLock,
  running: LocalCoreBuildIdentityV1 | undefined,
): LocalCoreDaemonCompatibility {
  if (running === undefined) return "legacy";
  if (lock.coreVersion !== expected.suiteVersion) return "version_mismatch";
  return running.buildId === expected.buildId && running.suiteVersion === expected.suiteVersion
    ? "current"
    : "outdated";
}

async function requestCodeUpdateShutdown(
  client: LocalCoreClient,
  allowLegacyDesktopFallback: boolean,
) {
  try {
    return await client.shutdownForCodeUpdate();
  } catch (error) {
    if (
      allowLegacyDesktopFallback
      && error instanceof LocalCoreApiError
      && error.statusCode === 400
    ) {
      return await client.shutdownForDesktopUpdate();
    }
    if (error instanceof LocalCoreApiError && error.statusCode === 404) {
      throw new Error(
        "The running Local Core cannot report lifecycle safety. Stop it manually before upgrading.",
        { cause: error },
      );
    }
    throw error;
  }
}

function isAuthorityDisconnect(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPIPE"
    || code === "ECONNRESET"
    || code === "ECONNREFUSED"
    || code === "ENOENT";
}

async function waitForDaemonExit(input: {
  homePath: string;
  ownerPid?: number | undefined;
  timeoutMs: number;
  intervalMs: number;
  isPidAlive?: ((pid: number) => boolean) | undefined;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    const lock = await readCoreLock({
      homePath: input.homePath,
      isPidAlive: input.isPidAlive,
    });
    if (
      lock.state === "missing"
      || lock.state === "stale"
      || (lock.state === "live" && input.ownerPid !== undefined && lock.lock.ownerPid !== input.ownerPid)
    ) {
      return;
    }
    await sleep(input.intervalMs);
  }
  throw new Error(
    `Kestrel Local Core did not finish its graceful shutdown within ${input.timeoutMs}ms.`,
  );
}

function spawnDaemon(input: {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | undefined;
  coreVersion: string;
  buildIdentity: LocalCoreBuildIdentityV1;
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
    KESTREL_CORE_BUILD_ID: input.buildIdentity.buildId,
    ...(input.buildIdentity.sourceCommit !== undefined
      ? { KESTREL_SOURCE_COMMIT: input.buildIdentity.sourceCommit }
      : {}),
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
  homePath: string;
  timeoutMs: number;
  intervalMs: number;
  spawned: SpawnedLocalCoreDaemon;
  expectedBuildIdentity: LocalCoreBuildIdentityV1;
  isPidAlive?: ((pid: number) => boolean) | undefined;
}): Promise<{
  status: LocalCoreStatus;
  client: LocalCoreClient;
  connection: LocalCoreConnectionDescriptor;
}> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < input.timeoutMs) {
    try {
      const inspected = await inspectWithExpected(
        {
          env: {
            NODE_ENV: process.env.NODE_ENV ?? "production",
            KESTREL_CORE_HOME: input.homePath,
          },
          coreVersion: input.expectedBuildIdentity.suiteVersion,
          buildIdentity: input.expectedBuildIdentity,
          isPidAlive: input.isPidAlive,
        },
        input.expectedBuildIdentity,
      );
      if (
        inspected.inspection.state === "running"
        && inspected.inspection.compatibility === "current"
        && inspected.client !== undefined
        && inspected.connection !== undefined
      ) {
        return {
          status: await inspected.client.status(),
          client: inspected.client,
          connection: inspected.connection,
        };
      }
      lastError = inspected.inspection.reason
        ?? `Local Core state is ${inspected.inspection.state}/${inspected.inspection.compatibility}.`;
    } catch (error) {
      lastError = error;
    }
    await sleep(input.intervalMs);
  }
  const startupFailure = input.spawned.readStartupFailure();
  throw new Error(
    `Kestrel Local Core daemon did not become ready: ${
      startupFailure?.message
      ?? (lastError instanceof Error ? lastError.message : String(lastError))
    }. See ${input.spawned.logPath} for daemon output.`,
    startupFailure !== undefined ? { cause: startupFailure } : undefined,
  );
}

function resolveExpectedBuildIdentity(
  options: EnsureLocalCoreDaemonReadyOptions,
  env: NodeJS.ProcessEnv,
): LocalCoreBuildIdentityV1 {
  const runtimeRoot = normalizeString(env.KESTREL_CLI_LIBEXEC)
    ?? options.repoRoot
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return resolveLocalCoreBuildIdentity({
    runtimeRoot,
    suiteVersion: options.coreVersion,
    manifestRequired: env.KESTREL_CORE_BUILD_MANIFEST_REQUIRED === "1",
    ...(env.KESTREL_SOURCE_COMMIT !== undefined
      ? { sourceCommit: env.KESTREL_SOURCE_COMMIT }
      : {}),
  });
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
