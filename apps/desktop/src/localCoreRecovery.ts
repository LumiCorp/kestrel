import { access, readFile } from "node:fs/promises";

import {
  LocalCoreApiError,
  LocalCoreClient,
} from "../../../src/localCore/client.js";
import type {
  LocalCoreSystemShutdownResult,
} from "../../../src/localCore/contracts.js";
import { resolveLocalCorePaths } from "../../../src/localCore/home.js";
import { readCoreLock } from "../../../src/localCore/lock.js";
import type {
  DesktopRestartKestrelInput,
  DesktopRestartKestrelResult,
} from "./contracts.js";

export interface DesktopLocalCoreRecoveryOwner {
  pid: number;
  authorityId?: string | undefined;
  socketPath: string;
}

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
  let pending: Promise<DesktopRestartKestrelResult> | undefined;
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
      const current = await input.operations.inspectOwner();
      if (current !== undefined && sameOwner(current, owner) === false) {
        return "owner_changed";
      }
      if (
        input.operations.isProcessAlive(owner.pid) === false &&
        await input.operations.areCoreResourcesReleased(owner)
      ) {
        return "released";
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

  return {
    restart(restartInput) {
      if (pending !== undefined) return pending;
      const operation = restartInput.force ? runForce() : runGraceful();
      let current!: Promise<DesktopRestartKestrelResult>;
      current = operation.finally(() => {
        if (pending === current) pending = undefined;
      });
      pending = current;
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
      const lock = await readCoreLock({
        homePath,
        isPidAlive: isLocalCoreProcessAlive,
      });
      if (lock.state !== "live") return;
      return {
        pid: lock.lock.ownerPid,
        ...(lock.lock.authorityId !== undefined
          ? { authorityId: lock.lock.authorityId }
          : {}),
        socketPath: lock.lock.socketPath ?? paths.apiSocketPath,
      };
    },
    async connect(owner) {
      try {
        const token = (await readFile(paths.apiTokenPath, "utf8")).trim();
        if (token.length === 0) return;
        return new LocalCoreClient({
          socketPath: owner.socketPath,
          token,
          timeoutMs: 10_000,
        });
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
  return left.pid === right.pid && left.authorityId === right.authorityId;
}

function isLocalCoreProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
