import { execFile } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";

import {
  LocalCoreApiError,
  LocalCoreClient,
} from "../../../src/localCore/client.js";
import type {
  LocalCoreSystemShutdownResult,
} from "../../../src/localCore/contracts.js";
import { resolveLocalCorePaths } from "../../../src/localCore/home.js";
import { readCoreLock } from "../../../src/localCore/lock.js";
import { isLocalCoreProcessAlive } from "../../../src/localCore/ready.js";
import { resolveLocalCoreDaemonEntrypoint } from "../../../src/localCore/daemon.js";
import type {
  DesktopRestartKestrelInput,
  DesktopRestartKestrelResult,
} from "./contracts.js";

export interface DesktopLocalCoreRecoveryOwner {
  pid: number;
  authorityId?: string | undefined;
  socketPath: string;
  ownerExecutable?: string | undefined;
  heartbeatStale?: boolean | undefined;
  executableVerified?: boolean | undefined;
  processIdentity?: string | undefined;
  socketIdentity?: string | undefined;
}

const execFileAsync = promisify(execFile);

export interface DesktopLocalCoreRecoveryClient {
  shutdownForDesktopRestart(): Promise<LocalCoreSystemShutdownResult>;
  shutdownForDesktopUpdate(): Promise<LocalCoreSystemShutdownResult>;
}

export interface DesktopLocalCoreRecoveryOperations {
  inspectOwner(): Promise<DesktopLocalCoreRecoveryOwner | undefined>;
  connect(
    owner: DesktopLocalCoreRecoveryOwner,
  ): Promise<DesktopLocalCoreRecoveryClient | undefined>;
  areCoreResourcesReleased(owner: DesktopLocalCoreRecoveryOwner): Promise<boolean>;
  isProcessAlive(pid: number): boolean;
  signalProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  wait(durationMs: number): Promise<void>;
}

export function parseDesktopRestartKestrelInput(
  value: unknown,
): DesktopRestartKestrelInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop restart Kestrel input must be an object.");
  }
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).find((key) => key !== "force");
  if (unsupported !== undefined) {
    throw new Error(
      `Desktop restart Kestrel input field '${unsupported}' is unsupported.`,
    );
  }
  if (typeof record.force !== "boolean") {
    throw new Error("Desktop restart Kestrel input.force must be boolean.");
  }
  return { force: record.force };
}

export interface DesktopStartupRecoveryCoordinator {
  restart(
    input: DesktopRestartKestrelInput,
  ): Promise<DesktopRestartKestrelResult>;
  recoverStartupFailure(): Promise<DesktopRestartKestrelResult | undefined>;
}

export function createDesktopStartupRecoveryCoordinator(input: {
  operations: DesktopLocalCoreRecoveryOperations;
  prepareDesktop(): Promise<void>;
  relaunchDesktop(): void;
  gracefulExitTimeoutMs?: number | undefined;
  sigtermTimeoutMs?: number | undefined;
  sigkillTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
}): DesktopStartupRecoveryCoordinator {
  const gracefulExitTimeoutMs = input.gracefulExitTimeoutMs ?? 10_000;
  const sigtermTimeoutMs = input.sigtermTimeoutMs ?? 10_000;
  const sigkillTimeoutMs = input.sigkillTimeoutMs ?? 5_000;
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  let pendingRestart: Promise<DesktopRestartKestrelResult> | undefined;
  let pendingAutomatic: Promise<DesktopRestartKestrelResult | undefined> | undefined;
  let blockedOwner: DesktopLocalCoreRecoveryOwner | undefined;

  const completeRestart = async (): Promise<DesktopRestartKestrelResult> => {
    blockedOwner = undefined;
    await input.prepareDesktop();
    input.relaunchDesktop();
    return { status: "restarting" };
  };

  const waitForOwnerExit = async (
    owner: DesktopLocalCoreRecoveryOwner,
    timeoutMs: number,
  ): Promise<"released" | "owner_changed" | "timeout"> => {
    for (let elapsedMs = 0; elapsedMs <= timeoutMs; elapsedMs += pollIntervalMs) {
      const processAlive = input.operations.isProcessAlive(owner.pid);
      if (processAlive === false) {
        if (await input.operations.areCoreResourcesReleased(owner)) {
          return "released";
        }
        if (elapsedMs < timeoutMs) {
          await input.operations.wait(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
        }
        continue;
      }
      const current = await input.operations.inspectOwner();
      if (current !== undefined && sameOwner(current, owner) === false) {
        return "owner_changed";
      }
      if (elapsedMs < timeoutMs) {
        await input.operations.wait(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
      }
    }
    return "timeout";
  };

  const runGraceful = async (): Promise<DesktopRestartKestrelResult> => {
    const owner = await input.operations.inspectOwner();
    if (owner === undefined) {
      return await completeRestart();
    }
    blockedOwner = owner;
    const client = await input.operations.connect(owner);
    const verifiedOwner = await input.operations.inspectOwner();
    if (
      verifiedOwner !== undefined &&
      sameOwner(verifiedOwner, owner) === false
    ) {
      blockedOwner = undefined;
      return ownerChangedResult();
    }
    if (client === undefined) {
      return blockedResult(
        "LOCAL_CORE_RECOVERY_CONNECTION_UNAVAILABLE",
        "Kestrel could not reach the current Local Core process. Force restart is available.",
        true,
      );
    }

    let shutdown: LocalCoreSystemShutdownResult;
    try {
      shutdown = await client.shutdownForDesktopRestart();
    } catch (error) {
      if (isLegacyShutdownContractError(error)) {
        try {
          shutdown = await client.shutdownForDesktopUpdate();
        } catch (fallbackError) {
          return blockedResult(
            "LOCAL_CORE_RECOVERY_CONNECTION_UNAVAILABLE",
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError),
            true,
          );
        }
      } else {
        return blockedResult(
          "LOCAL_CORE_RECOVERY_CONNECTION_UNAVAILABLE",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    }
    if (shutdown.status === "blocked") {
      return {
        status: "blocked",
        blockers: shutdown.lifecycle.blockers,
        forceAvailable: true,
      };
    }

    const exit = await waitForOwnerExit(owner, gracefulExitTimeoutMs);
    if (exit === "owner_changed") {
      blockedOwner = undefined;
      return ownerChangedResult();
    }
    if (exit === "timeout") {
      return blockedResult(
        "LOCAL_CORE_SHUTDOWN_TIMEOUT",
        "Local Core accepted the restart request but did not exit in time.",
        true,
      );
    }
    return await completeRestart();
  };

  const runForce = async (): Promise<DesktopRestartKestrelResult> => {
    const expectedOwner = blockedOwner;
    if (expectedOwner === undefined) {
      return blockedResult(
        "LOCAL_CORE_FORCE_CONFIRMATION_REQUIRED",
        "Try Restart Kestrel once before forcing Local Core to stop.",
        false,
      );
    }
    const currentOwner = await input.operations.inspectOwner();
    if (currentOwner === undefined) {
      const exit = await waitForOwnerExit(expectedOwner, sigkillTimeoutMs);
      if (exit === "released") {
        return await completeRestart();
      }
      if (exit === "owner_changed") {
        blockedOwner = undefined;
        return ownerChangedResult();
      }
      return blockedResult(
        "LOCAL_CORE_FORCE_STOP_FAILED",
        "Local Core stopped but did not release its socket and lock.",
        false,
      );
    }
    if (sameOwner(currentOwner, expectedOwner) === false) {
      blockedOwner = undefined;
      return ownerChangedResult();
    }

    input.operations.signalProcess(expectedOwner.pid, "SIGTERM");
    const termExit = await waitForOwnerExit(expectedOwner, sigtermTimeoutMs);
    if (termExit === "owner_changed") {
      blockedOwner = undefined;
      return ownerChangedResult();
    }
    if (termExit === "timeout") {
      const ownerBeforeKill = await input.operations.inspectOwner();
      if (ownerBeforeKill === undefined) {
        return blockedResult(
          "LOCAL_CORE_FORCE_STOP_FAILED",
          "Local Core stopped but did not release its socket and lock.",
          false,
        );
      }
      if (sameOwner(ownerBeforeKill, expectedOwner) === false) {
        blockedOwner = undefined;
        return ownerChangedResult();
      }
      input.operations.signalProcess(expectedOwner.pid, "SIGKILL");
      const killExit = await waitForOwnerExit(expectedOwner, sigkillTimeoutMs);
      if (killExit === "owner_changed") {
        blockedOwner = undefined;
        return ownerChangedResult();
      }
      if (killExit === "timeout") {
        return blockedResult(
          "LOCAL_CORE_FORCE_STOP_FAILED",
          "Local Core did not stop after forced termination.",
          false,
        );
      }
    }
    return await completeRestart();
  };

  const runAutomatic = async (): Promise<DesktopRestartKestrelResult | undefined> => {
    const owner = await input.operations.inspectOwner();
    if (
      owner === undefined
      || owner.heartbeatStale !== true
      || owner.executableVerified !== true
      || owner.processIdentity === undefined
      || owner.socketIdentity === undefined
      || owner.authorityId === undefined
      || input.operations.isProcessAlive(owner.pid) === false
    ) return;

    // A responsive authenticated Core is never signaled. Startup may report
    // the original failure, but recovery cannot take ownership from it.
    const client = await input.operations.connect(owner);
    const ownerAfterHandshake = await input.operations.inspectOwner();
    if (ownerAfterHandshake === undefined || sameOwner(ownerAfterHandshake, owner) === false) {
      return ownerChangedResult();
    }
    if (client !== undefined) return;

    blockedOwner = owner;
    input.operations.signalProcess(owner.pid, "SIGTERM");
    const termExit = await waitForOwnerExit(owner, sigtermTimeoutMs);
    if (termExit === "owner_changed") {
      blockedOwner = undefined;
      return ownerChangedResult();
    }
    if (termExit === "timeout") {
      const ownerBeforeKill = await input.operations.inspectOwner();
      if (ownerBeforeKill === undefined || sameOwner(ownerBeforeKill, owner) === false) {
        blockedOwner = undefined;
        return ownerChangedResult();
      }
      input.operations.signalProcess(owner.pid, "SIGKILL");
      const killExit = await waitForOwnerExit(owner, sigkillTimeoutMs);
      if (killExit === "owner_changed") {
        blockedOwner = undefined;
        return ownerChangedResult();
      }
      if (killExit === "timeout") {
        return blockedResult(
          "LOCAL_CORE_AUTOMATIC_RECOVERY_FAILED",
          "Local Core did not release its verified lock and socket. Use manual recovery from Diagnostics.",
          false,
        );
      }
    }
    return await completeRestart();
  };

  return {
    recoverStartupFailure() {
      if (pendingAutomatic !== undefined) return pendingAutomatic;
      const operation = runAutomatic();
      let current!: Promise<DesktopRestartKestrelResult | undefined>;
      current = operation.finally(() => {
        if (pendingAutomatic === current) pendingAutomatic = undefined;
      });
      pendingAutomatic = current;
      return current;
    },
    restart(restartInput) {
      if (pendingRestart !== undefined) return pendingRestart;
      const operation = restartInput.force ? runForce() : runGraceful();
      let current!: Promise<DesktopRestartKestrelResult>;
      current = operation.finally(() => {
        if (pendingRestart === current) pendingRestart = undefined;
      });
      pendingRestart = current;
      return current;
    },
  };
}

export function createDesktopLocalCoreRecoveryOperations(
  homePath: string,
): DesktopLocalCoreRecoveryOperations {
  const paths = resolveLocalCorePaths(homePath);
  return {
    async inspectOwner() {
      const lock = await readCoreLock({ homePath });
      if (lock.state !== "live" && lock.state !== "stale" && lock.state !== "incompatible") return;
      const executableVerified = await isExpectedLocalCoreExecutable(lock.lock.ownerExecutable);
      const processIdentity = executableVerified
        ? await inspectLocalCoreProcessIdentity(
            lock.lock.ownerPid,
            lock.lock.ownerExecutable,
          )
        : undefined;
      const socketPath = lock.lock.socketPath ?? paths.apiSocketPath;
      const socketIdentity = await inspectPathIdentity(socketPath);
      return {
        pid: lock.lock.ownerPid,
        ...(lock.lock.authorityId !== undefined
          ? { authorityId: lock.lock.authorityId }
          : {}),
        socketPath,
        ownerExecutable: lock.lock.ownerExecutable,
        heartbeatStale: lock.state === "stale",
        executableVerified: executableVerified && processIdentity !== undefined,
        ...(processIdentity !== undefined ? { processIdentity } : {}),
        ...(socketIdentity !== undefined ? { socketIdentity } : {}),
      };
    },
    async connect(owner) {
      try {
        const token = (await readFile(paths.apiTokenPath, "utf8")).trim();
        if (token.length === 0) return;
        const client = new LocalCoreClient({
          socketPath: owner.socketPath,
          token,
          timeoutMs: 2_000,
        });
        await client.health();
        return client;
      } catch {
        return;
      }
    },
    async areCoreResourcesReleased(owner) {
      const [lockExists, socketExists] = await Promise.all([
        pathExists(paths.lockPath),
        pathExists(owner.socketPath),
      ]);
      return lockExists === false && socketExists === false;
    },
    isProcessAlive: isLocalCoreProcessAlive,
    signalProcess(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
    async wait(durationMs) {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    },
  };
}

function sameOwner(
  left: DesktopLocalCoreRecoveryOwner,
  right: DesktopLocalCoreRecoveryOwner,
): boolean {
  return left.pid === right.pid
    && left.authorityId === right.authorityId
    && left.socketPath === right.socketPath
    && left.ownerExecutable === right.ownerExecutable
    && left.processIdentity === right.processIdentity
    && left.socketIdentity === right.socketIdentity;
}

async function inspectLocalCoreProcessIdentity(
  pid: number,
  ownerExecutable: string,
): Promise<string | undefined> {
  const expectedEntrypoint = await normalizedRealpath(ownerExecutable);
  try {
    if (process.platform === "linux") {
      const [statLine, commandLine, executablePath] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/cmdline`),
        realpath(`/proc/${pid}/exe`),
      ]);
      const commandArgs = commandLine.toString("utf8").split("\0").filter(Boolean);
      if (commandArgs.some((argument) => pathMatches(argument, expectedEntrypoint)) === false) {
        return;
      }
      const closeParen = statLine.lastIndexOf(")");
      const fields = closeParen < 0 ? [] : statLine.slice(closeParen + 2).trim().split(/\s+/u);
      const startTicks = fields[19];
      if (startTicks === undefined) return;
      return `linux:${startTicks}:${await normalizedRealpath(executablePath)}:${commandArgs.join("\0")}`;
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync(
        "/bin/ps",
        ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="],
        { encoding: "utf8" },
      );
      const identity = stdout.trim();
      if (identity.length === 0 || identity.includes(expectedEntrypoint) === false) return;
      return `darwin:${identity}`;
    }
    if (process.platform === "win32") {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
        "if ($null -eq $p) { exit 1 }",
        "$p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
      ].join("; ");
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8" },
      );
      const identity = stdout.trim();
      if (identity.length === 0 || identity.includes(expectedEntrypoint) === false) return;
      return `win32:${identity}`;
    }
    return;
  } catch {
    return;
  }
}

async function inspectPathIdentity(filePath: string): Promise<string | undefined> {
  try {
    const value = await stat(filePath);
    return `${value.dev}:${value.ino}:${value.ctimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function normalizedRealpath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return filePath;
  }
}

function pathMatches(candidate: string, expected: string): boolean {
  return candidate === expected || candidate.replaceAll("\\", "/") === expected.replaceAll("\\", "/");
}

async function isExpectedLocalCoreExecutable(ownerExecutable: string): Promise<boolean> {
  const expected = resolveLocalCoreDaemonEntrypoint({ env: process.env });
  try {
    const [ownerPath, expectedPath] = await Promise.all([
      realpath(ownerExecutable),
      realpath(expected),
    ]);
    return ownerPath === expectedPath;
  } catch {
    return ownerExecutable === expected;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isLegacyShutdownContractError(error: unknown): boolean {
  return error instanceof LocalCoreApiError &&
    error.statusCode === 400 &&
    error.code === "LOCAL_CORE_SHUTDOWN_INVALID";
}

function blockedResult(
  code: string,
  message: string,
  forceAvailable: boolean,
): DesktopRestartKestrelResult {
  return {
    status: "blocked",
    blockers: [{ code, message, count: 1 }],
    forceAvailable,
  };
}

function ownerChangedResult(): DesktopRestartKestrelResult {
  return blockedResult(
    "LOCAL_CORE_OWNER_CHANGED",
    "Local Core ownership changed. Retry the normal restart before forcing it.",
    false,
  );
}
