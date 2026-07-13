import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_CORE_LOCK_VERSION,
  type LocalCoreLock,
  type LocalCoreLockReadResult,
} from "./contracts.js";
import { resolveLocalCorePaths } from "./home.js";

const DEFAULT_STALE_AFTER_MS = 30_000;
const ACQUISITION_RETRY_MS = 10;
const ACQUISITION_WAIT_TIMEOUT_MS = 5_000;

export async function readCoreLock(input: {
  homePath: string;
  currentCoreVersion?: string | undefined;
  now?: Date | undefined;
  staleAfterMs?: number | undefined;
  isPidAlive?: ((pid: number) => boolean) | undefined;
}): Promise<LocalCoreLockReadResult> {
  const lockPath = resolveLocalCorePaths(input.homePath).lockPath;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (isNotFoundError(error)) {
      return { state: "missing", lockPath };
    }
    return { state: "repair_required", lockPath, reason: "Kestrel Local Core lock is unreadable.", raw };
  }

  const parsed = parseCoreLock(raw);
  if (parsed === undefined) {
    return { state: "repair_required", lockPath, reason: "Kestrel Local Core lock is invalid.", raw };
  }
  const now = input.now ?? new Date();
  const heartbeatMs = Date.parse(parsed.heartbeatAt);
  if (Number.isFinite(heartbeatMs) === false) {
    return { state: "repair_required", lockPath, reason: "Kestrel Local Core lock heartbeat is invalid.", raw };
  }
  if (input.isPidAlive !== undefined) {
    if (input.isPidAlive(parsed.ownerPid) === false) {
      return { state: "stale", lockPath, lock: parsed, reason: "Kestrel Local Core owner process is not alive." };
    }
  } else if (now.getTime() - heartbeatMs > (input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)) {
    return { state: "stale", lockPath, lock: parsed, reason: "Kestrel Local Core heartbeat is stale." };
  }
  if (input.currentCoreVersion !== undefined && parsed.coreVersion !== input.currentCoreVersion) {
    return {
      state: "incompatible",
      lockPath,
      lock: parsed,
      reason: `Core lock version ${parsed.coreVersion} does not match shell version ${input.currentCoreVersion}.`,
    };
  }
  return { state: "live", lockPath, lock: parsed };
}

export async function acquireCoreLock(input: {
  homePath: string;
  coreVersion: string;
  ownerExecutable: string;
  authorityId?: string | undefined;
  schemaVersion?: number | undefined;
  ownerPid?: number | undefined;
  now?: Date | undefined;
  staleAfterMs?: number | undefined;
  isPidAlive?: ((pid: number) => boolean) | undefined;
  socketPath?: string | undefined;
  databaseSocketPath?: string | undefined;
}): Promise<LocalCoreLockReadResult> {
  const paths = resolveLocalCorePaths(input.homePath);
  await mkdir(path.dirname(paths.lockPath), { recursive: true, mode: 0o700 });
  const acquisition = await acquireLockAcquisitionGuard(paths.lockPath);
  if (acquisition === undefined) {
    return lockAcquisitionRepairRequired(paths.lockPath);
  }

  try {
    const current = await readCoreLock({
      homePath: input.homePath,
      currentCoreVersion: input.coreVersion,
      now: input.now,
      staleAfterMs: input.staleAfterMs,
      isPidAlive: input.isPidAlive,
    });
    if (current.state === "live" || current.state === "incompatible" || current.state === "repair_required") {
      return current;
    }

    const timestamp = (input.now ?? new Date()).toISOString();
    const lock: LocalCoreLock = {
      version: LOCAL_CORE_LOCK_VERSION,
      ownerPid: input.ownerPid ?? process.pid,
      ...(input.authorityId !== undefined ? { authorityId: input.authorityId } : {}),
      ownerExecutable: input.ownerExecutable,
      coreVersion: input.coreVersion,
      ...(input.schemaVersion !== undefined ? { schemaVersion: input.schemaVersion } : {}),
      startedAt: timestamp,
      heartbeatAt: timestamp,
      ...(input.socketPath !== undefined ? { socketPath: input.socketPath } : {}),
      ...(input.databaseSocketPath !== undefined ? { databaseSocketPath: input.databaseSocketPath } : {}),
    };
    if (current.state === "stale") {
      await rm(paths.lockPath, { force: true });
    }
    try {
      await writeFile(paths.lockPath, `${JSON.stringify(lock, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        return await readCoreLock({
          homePath: input.homePath,
          currentCoreVersion: input.coreVersion,
          now: input.now,
          staleAfterMs: input.staleAfterMs,
          isPidAlive: input.isPidAlive,
        });
      }
      throw error;
    }
    return { state: "live", lockPath: paths.lockPath, lock };
  } finally {
    await releaseLockAcquisitionGuard(acquisition);
  }
}

export async function writeCoreLockHeartbeat(input: {
  homePath: string;
  coreVersion: string;
  ownerPid?: number | undefined;
  authorityId?: string | undefined;
  now?: Date | undefined;
}): Promise<LocalCoreLockReadResult> {
  const lockPath = resolveLocalCorePaths(input.homePath).lockPath;
  const acquisition = await acquireLockAcquisitionGuard(lockPath);
  if (acquisition === undefined) {
    return lockAcquisitionRepairRequired(lockPath);
  }

  try {
    const current = await readCoreLock({
      homePath: input.homePath,
      currentCoreVersion: input.coreVersion,
      now: input.now,
    });
    if (current.state !== "live") {
      return current;
    }
    const ownerPid = input.ownerPid ?? process.pid;
    if (current.lock.ownerPid !== ownerPid) {
      return {
        state: "repair_required",
        lockPath: current.lockPath,
        reason: "Kestrel Local Core heartbeat owner does not match the active process.",
        raw: current.lock,
      };
    }
    if (
      input.authorityId !== undefined
      && current.lock.authorityId !== input.authorityId
    ) {
      return {
        state: "repair_required",
        lockPath: current.lockPath,
        reason: "Kestrel Local Core heartbeat authority does not match the active instance.",
        raw: current.lock,
      };
    }
    const updated: LocalCoreLock = {
      ...current.lock,
      heartbeatAt: (input.now ?? new Date()).toISOString(),
    };
    await writeFile(current.lockPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    return { state: "live", lockPath: current.lockPath, lock: updated };
  } finally {
    await releaseLockAcquisitionGuard(acquisition);
  }
}

export async function releaseCoreLock(input: {
  homePath: string;
  coreVersion: string;
  ownerPid?: number | undefined;
  authorityId?: string | undefined;
}): Promise<void> {
  const lockPath = resolveLocalCorePaths(input.homePath).lockPath;
  const acquisition = await acquireLockAcquisitionGuard(lockPath);
  if (acquisition === undefined) {
    throw new Error(lockAcquisitionRepairRequired(lockPath).reason);
  }

  try {
    const current = await readCoreLock({
      homePath: input.homePath,
      currentCoreVersion: input.coreVersion,
    });
    if (current.state !== "live") {
      return;
    }
    if (current.lock.ownerPid !== (input.ownerPid ?? process.pid)) {
      return;
    }
    if (
      input.authorityId !== undefined
      && current.lock.authorityId !== input.authorityId
    ) {
      return;
    }
    await rm(current.lockPath, { force: true });
  } finally {
    await releaseLockAcquisitionGuard(acquisition);
  }
}

function parseCoreLock(value: unknown): LocalCoreLock | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Partial<LocalCoreLock>;
  if (
    record.version !== LOCAL_CORE_LOCK_VERSION ||
    typeof record.ownerPid !== "number" ||
    Number.isInteger(record.ownerPid) === false ||
    typeof record.ownerExecutable !== "string" ||
    typeof record.coreVersion !== "string" ||
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
    ...(typeof record.authorityId === "string" && record.authorityId.trim().length > 0
      ? { authorityId: record.authorityId }
      : {}),
    ownerExecutable: record.ownerExecutable,
    coreVersion: record.coreVersion,
    ...(typeof record.schemaVersion === "number" ? { schemaVersion: record.schemaVersion } : {}),
    startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt,
    ...(typeof record.socketPath === "string" ? { socketPath: record.socketPath } : {}),
    ...(typeof record.databaseSocketPath === "string" ? { databaseSocketPath: record.databaseSocketPath } : {}),
  };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

interface LockAcquisitionGuard {
  path: string;
  token: string;
}

/**
 * Serializes every lock-file mutation. A crash-left guard is deliberately not
 * stolen: contenders time out as repair-required instead of risking removal
 * of a live authority's guard and lock.
 */
async function acquireLockAcquisitionGuard(lockPath: string): Promise<LockAcquisitionGuard | undefined> {
  const guardPath = acquisitionGuardPath(lockPath);
  const token = randomUUID();
  const deadline = Date.now() + ACQUISITION_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      await writeFile(guardPath, `${token}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { path: guardPath, token };
    } catch (error) {
      if (isAlreadyExistsError(error) === false) {
        throw error;
      }
      if (Date.now() >= deadline) {
        return undefined;
      }
      await delay(ACQUISITION_RETRY_MS);
    }
  }
}

async function releaseLockAcquisitionGuard(guard: LockAcquisitionGuard): Promise<void> {
  let token: string;
  try {
    token = (await readFile(guard.path, "utf8")).trim();
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }
  if (token === guard.token) {
    await rm(guard.path, { force: true });
  }
}

function acquisitionGuardPath(lockPath: string): string {
  return `${lockPath}.acquire`;
}

function lockAcquisitionRepairRequired(lockPath: string): Extract<LocalCoreLockReadResult, { state: "repair_required" }> {
  return {
    state: "repair_required",
    lockPath,
    reason: "Kestrel Local Core lock acquisition is already in progress and did not complete; remove the stale acquisition guard during repair.",
    raw: {
      acquisitionPath: acquisitionGuardPath(lockPath),
      waitTimeoutMs: ACQUISITION_WAIT_TIMEOUT_MS,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
