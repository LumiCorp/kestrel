import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  LOCAL_CORE_LOCK_VERSION,
  type LocalCoreFailure,
  type LocalCoreMigrationLock,
  type LocalCoreMigrationLockReadResult,
  type LocalCoreMigrationStatus,
} from "./contracts.js";
import { resolveLocalCorePaths } from "./home.js";

const DEFAULT_STALE_AFTER_MS = 30_000;
const MAX_MIGRATION_OUTPUT_CHARS = 4_000;

export interface LocalCoreMigrationCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface LocalCoreMigrationCommandInput {
  repoRoot: string;
  databaseUrl: string;
  env: NodeJS.ProcessEnv;
}

export async function readCoreMigrationLock(input: {
  homePath: string;
  currentCoreVersion?: string | undefined;
  currentSchemaVersion?: number | undefined;
  now?: Date | undefined;
  staleAfterMs?: number | undefined;
  isPidAlive?: ((pid: number) => boolean) | undefined;
}): Promise<LocalCoreMigrationLockReadResult> {
  const lockPath = resolveLocalCorePaths(input.homePath).migrationLockPath;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (isNotFoundError(error)) {
      return { state: "missing", lockPath };
    }
    return { state: "repair_required", lockPath, reason: "Kestrel Local Core migration lock is unreadable.", raw };
  }

  const parsed = parseMigrationLock(raw);
  if (parsed === undefined) {
    return { state: "repair_required", lockPath, reason: "Kestrel Local Core migration lock is invalid.", raw };
  }
  if (input.currentCoreVersion !== undefined && parsed.coreVersion !== input.currentCoreVersion) {
    return {
      state: "incompatible",
      lockPath,
      lock: parsed,
      reason: `Migration lock core version ${parsed.coreVersion} does not match shell version ${input.currentCoreVersion}.`,
    };
  }
  if (input.currentSchemaVersion !== undefined && parsed.schemaVersion !== input.currentSchemaVersion) {
    return {
      state: "incompatible",
      lockPath,
      lock: parsed,
      reason: `Migration lock schema version ${parsed.schemaVersion} does not match requested schema version ${input.currentSchemaVersion}.`,
    };
  }
  const now = input.now ?? new Date();
  const heartbeatMs = Date.parse(parsed.heartbeatAt);
  if (Number.isFinite(heartbeatMs) === false) {
    return { state: "repair_required", lockPath, reason: "Kestrel Local Core migration lock heartbeat is invalid.", raw };
  }
  if (input.isPidAlive !== undefined) {
    if (input.isPidAlive(parsed.ownerPid) === false) {
      return { state: "stale", lockPath, lock: parsed, reason: "Kestrel Local Core migration owner process is not alive." };
    }
    return { state: "live", lockPath, lock: parsed };
  }
  if (now.getTime() - heartbeatMs > (input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)) {
    return { state: "stale", lockPath, lock: parsed, reason: "Kestrel Local Core migration heartbeat is stale." };
  }
  return { state: "live", lockPath, lock: parsed };
}

export async function acquireCoreMigrationLock(input: {
  homePath: string;
  coreVersion: string;
  schemaVersion: number;
  ownerExecutable: string;
  ownerPid?: number | undefined;
  now?: Date | undefined;
  staleAfterMs?: number | undefined;
  isPidAlive?: ((pid: number) => boolean) | undefined;
}): Promise<LocalCoreMigrationLockReadResult> {
  const current = await readCoreMigrationLock({
    homePath: input.homePath,
    currentCoreVersion: input.coreVersion,
    currentSchemaVersion: input.schemaVersion,
    now: input.now,
    staleAfterMs: input.staleAfterMs,
    isPidAlive: input.isPidAlive,
  });
  if (current.state === "live" || current.state === "incompatible" || current.state === "repair_required") {
    return current;
  }

  const paths = resolveLocalCorePaths(input.homePath);
  const timestamp = (input.now ?? new Date()).toISOString();
  const lock: LocalCoreMigrationLock = {
    version: LOCAL_CORE_LOCK_VERSION,
    ownerPid: input.ownerPid ?? process.pid,
    ownerExecutable: input.ownerExecutable,
    coreVersion: input.coreVersion,
    schemaVersion: input.schemaVersion,
    startedAt: timestamp,
    heartbeatAt: timestamp,
  };
  await mkdir(path.dirname(paths.migrationLockPath), { recursive: true });
  if (current.state === "stale") {
    await rm(paths.migrationLockPath, { force: true });
  }
  try {
    await writeFile(paths.migrationLockPath, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return await readCoreMigrationLock({
        homePath: input.homePath,
        currentCoreVersion: input.coreVersion,
        currentSchemaVersion: input.schemaVersion,
        now: input.now,
        staleAfterMs: input.staleAfterMs,
        isPidAlive: input.isPidAlive,
      });
    }
    throw error;
  }
  return { state: "live", lockPath: paths.migrationLockPath, lock };
}

export async function releaseCoreMigrationLock(input: {
  homePath: string;
  ownerPid?: number | undefined;
}): Promise<void> {
  const paths = resolveLocalCorePaths(input.homePath);
  const current = await readCoreMigrationLock({
    homePath: input.homePath,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  if (current.state !== "live") {
    return;
  }
  if (current.lock.ownerPid !== (input.ownerPid ?? process.pid)) {
    return;
  }
  await rm(paths.migrationLockPath, { force: true });
}

export async function runLocalCoreMigrations(input: {
  homePath: string;
  coreVersion: string;
  schemaVersion: number;
  ownerExecutable: string;
  databaseUrl: string;
  repoRoot: string;
  env?: NodeJS.ProcessEnv | undefined;
  now?: Date | undefined;
  isPidAlive?: ((pid: number) => boolean) | undefined;
  runCommandImpl?: ((input: LocalCoreMigrationCommandInput) => Promise<LocalCoreMigrationCommandResult>) | undefined;
}): Promise<LocalCoreMigrationStatus> {
  const lock = await acquireCoreMigrationLock({
    homePath: input.homePath,
    coreVersion: input.coreVersion,
    schemaVersion: input.schemaVersion,
    ownerExecutable: input.ownerExecutable,
    now: input.now,
    isPidAlive: input.isPidAlive,
  });
  if (lock.state !== "live") {
    const reason = "reason" in lock && typeof lock.reason === "string"
      ? lock.reason
      : "Kestrel Local Core migration lock is not held.";
    return {
      state: "blocked",
      summary: reason,
      schemaVersion: input.schemaVersion,
      lock,
      migrated: false,
      lastError: failure(
        lock.state === "incompatible" ? "LOCAL_CORE_MIGRATION_VERSION_INCOMPATIBLE" : "LOCAL_CORE_MIGRATION_LOCK_BLOCKED",
        reason,
      ),
    };
  }

  try {
    const result = input.runCommandImpl === undefined
      ? await runMigrationCommand({
        repoRoot: input.repoRoot,
        databaseUrl: input.databaseUrl,
        env: resolveMigrationEnvironment(input.env ?? process.env, input.databaseUrl),
      })
      : await input.runCommandImpl({
        repoRoot: input.repoRoot,
        databaseUrl: input.databaseUrl,
        env: resolveMigrationEnvironment(input.env ?? process.env, input.databaseUrl),
      });
    if (result.ok) {
      return {
        state: "healthy",
        summary: "Kestrel Local Core migrations complete.",
        schemaVersion: input.schemaVersion,
        lock,
        migrated: true,
      };
    }
    const message = summarizeMigrationFailure(result);
    return {
      state: "blocked",
      summary: "Kestrel Local Core migrations failed.",
      schemaVersion: input.schemaVersion,
      lock,
      migrated: false,
      lastError: failure("LOCAL_CORE_MIGRATION_FAILED", message),
    };
  } finally {
    await releaseCoreMigrationLock({ homePath: input.homePath });
  }
}

export function resolveMigrationEnvironment(baseEnv: NodeJS.ProcessEnv, databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    DATABASE_URL: databaseUrl,
    KESTREL_DISABLE_DOTENV: "1",
    KESTREL_LOCAL_CORE: "1",
  };
}

function runMigrationCommand(input: LocalCoreMigrationCommandInput): Promise<LocalCoreMigrationCommandResult> {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(input.repoRoot, "scripts", "migrate.ts")], {
    cwd: input.repoRoot,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return collectCommandResult(child);
}

function collectCommandResult(child: ChildProcess): Promise<LocalCoreMigrationCommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        code,
      });
    });
  });
}

function parseMigrationLock(value: unknown): LocalCoreMigrationLock | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Partial<LocalCoreMigrationLock>;
  if (
    record.version !== LOCAL_CORE_LOCK_VERSION ||
    typeof record.ownerPid !== "number" ||
    Number.isInteger(record.ownerPid) === false ||
    typeof record.ownerExecutable !== "string" ||
    typeof record.coreVersion !== "string" ||
    typeof record.schemaVersion !== "number" ||
    Number.isInteger(record.schemaVersion) === false ||
    typeof record.startedAt !== "string" ||
    typeof record.heartbeatAt !== "string" ||
    Number.isFinite(Date.parse(record.startedAt)) === false ||
    Number.isFinite(Date.parse(record.heartbeatAt)) === false
  ) {
    return undefined;
  }
  return {
    version: LOCAL_CORE_LOCK_VERSION,
    ownerPid: record.ownerPid,
    ownerExecutable: record.ownerExecutable,
    coreVersion: record.coreVersion,
    schemaVersion: record.schemaVersion,
    startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt,
  };
}

function failure(code: string, message: string, details?: Record<string, unknown>): LocalCoreFailure {
  return {
    code,
    message,
    ...(details !== undefined ? { details } : {}),
  };
}

function appendOutput(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  return next.length > MAX_MIGRATION_OUTPUT_CHARS
    ? next.slice(-MAX_MIGRATION_OUTPUT_CHARS)
    : next;
}

function summarizeMigrationFailure(result: LocalCoreMigrationCommandResult): string {
  const combined = `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  if (combined.length > 0) {
    return combined.length > MAX_MIGRATION_OUTPUT_CHARS
      ? combined.slice(-MAX_MIGRATION_OUTPUT_CHARS)
      : combined;
  }
  return `Migration process exited with code ${result.code ?? "unknown"}.`;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
