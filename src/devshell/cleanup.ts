import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  DEV_SHELL_BOOTSTRAP_STATUS_FILE,
  resolveDefaultDevShellBaseDir,
} from "./paths.js";

const execFileAsync = promisify(execFile);

export interface DevShellCleanupCandidate {
  statusPath: string;
  pid?: number | undefined;
  ownerPid?: number | undefined;
  ownerKind?: string | undefined;
  socketPath?: string | undefined;
  staleReason: "owner_process_exited" | "service_process_exited" | "missing_owner";
  action: "would_signal" | "signalled" | "none";
  signal?: "SIGTERM" | undefined;
  error?: string | undefined;
}

export interface DevShellCleanupResult {
  dryRun: boolean;
  scannedRoots: string[];
  candidates: DevShellCleanupCandidate[];
}

export async function cleanupDevShellServices(input: {
  apply?: boolean | undefined;
  roots?: string[] | undefined;
  maxDepth?: number | undefined;
  maxEntries?: number | undefined;
  verifyServiceProcess?: ((input: {
    pid: number;
    socketPath?: string | undefined;
  }) => Promise<boolean> | boolean) | undefined;
} = {}): Promise<DevShellCleanupResult> {
  const roots = input.roots ?? defaultCleanupRoots();
  const maxDepth = input.maxDepth ?? 7;
  const maxEntries = input.maxEntries ?? 5_000;
  const statusPaths: string[] = [];
  for (const root of roots) {
    await collectStatusPaths(root, {
      maxDepth,
      maxEntries,
      statusPaths,
    });
  }
  const candidates: DevShellCleanupCandidate[] = [];
  for (const statusPath of statusPaths) {
    const candidate = await readCleanupCandidate(statusPath, {
      apply: input.apply === true,
      verifyServiceProcess: input.verifyServiceProcess ?? verifyDevShellServiceProcess,
    });
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }
  return {
    dryRun: input.apply !== true,
    scannedRoots: roots,
    candidates,
  };
}

function defaultCleanupRoots(): string[] {
  return [
    resolveDefaultDevShellBaseDir(),
    path.join(tmpdir(), "kestrel-cli-prompt-smoke"),
  ];
}

async function collectStatusPaths(
  root: string,
  input: {
    maxDepth: number;
    maxEntries: number;
    statusPaths: string[];
  },
  depth = 0,
): Promise<void> {
  if (depth > input.maxDepth || input.statusPaths.length >= input.maxEntries) {
    return;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (input.statusPaths.length >= input.maxEntries) {
      return;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === DEV_SHELL_BOOTSTRAP_STATUS_FILE) {
      input.statusPaths.push(entryPath);
      continue;
    }
    if (entry.isDirectory()) {
      await collectStatusPaths(entryPath, input, depth + 1);
    }
  }
}

async function readCleanupCandidate(
  statusPath: string,
  options: {
    apply: boolean;
    verifyServiceProcess: (input: {
      pid: number;
      socketPath?: string | undefined;
    }) => Promise<boolean> | boolean;
  },
): Promise<DevShellCleanupCandidate | undefined> {
  const status = await readBootstrapStatus(statusPath);
  if (status === undefined) {
    return undefined;
  }
  const staleReason = classifyStaleReason(status);
  if (staleReason === undefined) {
    return undefined;
  }
  const baseCandidate = {
    statusPath,
    ...(status.pid !== undefined ? { pid: status.pid } : {}),
    ...(status.ownerPid !== undefined ? { ownerPid: status.ownerPid } : {}),
    ...(status.ownerKind !== undefined ? { ownerKind: status.ownerKind } : {}),
    ...(status.socketPath !== undefined ? { socketPath: status.socketPath } : {}),
    staleReason,
  };
  if (status.pid === undefined || isPidRunning(status.pid) === false || staleReason === "missing_owner") {
    return {
      ...baseCandidate,
      action: "none",
    };
  }
  const verifiedServiceProcess = await options.verifyServiceProcess({
    pid: status.pid,
    socketPath: status.socketPath,
  });
  if (verifiedServiceProcess === false) {
    return {
      ...baseCandidate,
      action: "none",
      error: "pid did not match a dev-shell service process",
    };
  }
  if (options.apply === false) {
    return {
      ...baseCandidate,
      action: "would_signal",
      signal: "SIGTERM",
    };
  }
  try {
    process.kill(status.pid, "SIGTERM");
    return {
      ...baseCandidate,
      action: "signalled",
      signal: "SIGTERM",
    };
  } catch (error) {
    return {
      ...baseCandidate,
      action: "none",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function classifyStaleReason(status: BootstrapStatus): DevShellCleanupCandidate["staleReason"] | undefined {
  if (status.pid !== undefined && isPidRunning(status.pid) === false) {
    return "service_process_exited";
  }
  if (status.ownerPid === undefined) {
    return "missing_owner";
  }
  if (isPidRunning(status.ownerPid) === false) {
    return "owner_process_exited";
  }
  return undefined;
}

interface BootstrapStatus {
  pid?: number | undefined;
  ownerPid?: number | undefined;
  ownerKind?: string | undefined;
  socketPath?: string | undefined;
}

async function readBootstrapStatus(statusPath: string): Promise<BootstrapStatus | undefined> {
  try {
    const parsed = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
    return {
      ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
      ...(typeof parsed.ownerPid === "number" ? { ownerPid: parsed.ownerPid } : {}),
      ...(typeof parsed.ownerKind === "string" ? { ownerKind: parsed.ownerKind } : {}),
      ...(typeof parsed.socketPath === "string" ? { socketPath: parsed.socketPath } : {}),
    };
  } catch {
    return undefined;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function verifyDevShellServiceProcess(input: {
  pid: number;
  socketPath?: string | undefined;
}): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(input.pid), "-o", "command="], {
      timeout: 1_000,
      maxBuffer: 16_384,
    });
    const command = stdout.trim();
    if (command.includes("cli/dev-shell/service") === false) {
      return false;
    }
    return input.socketPath === undefined || command.includes(input.socketPath);
  } catch {
    return false;
  }
}
