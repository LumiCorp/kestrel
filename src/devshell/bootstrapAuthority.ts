import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";

const BOOTSTRAP_AUTHORITY_VERSION = "kestrel-dev-shell-bootstrap-v1";

interface BootstrapAuthorityIdentity {
  device: number;
  inode: number;
  target: string;
}

export interface DevShellBootstrapAuthorityLease {
  ownerPid: number;
  ownerToken: string;
  release(): Promise<void>;
}

export type DevShellBootstrapAuthorityResult =
  | {
      status: "acquired";
      lease: DevShellBootstrapAuthorityLease;
    }
  | {
      status: "unavailable";
      reason: "invalid_owner_evidence" | "wait_timeout";
      ownerPid?: number | undefined;
    };

export function createDevShellBootstrapAuthorityToken(): string {
  return randomUUID();
}

export async function acquireDevShellBootstrapAuthority(input: {
  authorityPath: string;
  ownerToken: string;
  timeoutMs: number;
  pollIntervalMs: number;
  ownerPid?: number | undefined;
}): Promise<DevShellBootstrapAuthorityResult> {
  const ownerPid = input.ownerPid ?? process.pid;
  const target = formatOwnerEvidence(ownerPid, input.ownerToken);
  const deadline = Date.now() + input.timeoutMs;
  await mkdir(path.dirname(input.authorityPath), { recursive: true });

  while (true) {
    try {
      await mkdir(input.authorityPath);
      await symlink(target, ownerEvidencePath(input.authorityPath));
      const identity = await readAuthorityIdentity(input.authorityPath);
      if (identity === undefined || identity.target !== target) {
        return { status: "unavailable", reason: "invalid_owner_evidence" };
      }
      return {
        status: "acquired",
        lease: {
          ownerPid,
          ownerToken: input.ownerToken,
          release: async () => {
            await removeAuthorityIfOwned(input.authorityPath, identity);
          },
        },
      };
    } catch (error) {
      if (readNodeErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    const existing = await readAuthorityIdentity(input.authorityPath);
    if (existing === undefined) {
      const authorityPathKind = await readAuthorityPathKind(
        input.authorityPath,
      );
      if (authorityPathKind === "invalid") {
        return { status: "unavailable", reason: "invalid_owner_evidence" };
      }
      if (authorityPathKind === "directory" && Date.now() >= deadline) {
        return { status: "unavailable", reason: "invalid_owner_evidence" };
      }
      if (authorityPathKind === "directory") {
        await new Promise((resolve) =>
          setTimeout(resolve, input.pollIntervalMs),
        );
      }
      continue;
    }
    const owner = parseOwnerEvidence(existing.target);
    if (owner === undefined) {
      return { status: "unavailable", reason: "invalid_owner_evidence" };
    }
    if (isPidRunning(owner.pid) === false) {
      const removed = await removeAuthorityIfOwned(
        input.authorityPath,
        existing,
      );
      if (removed === false) {
        if (Date.now() >= deadline) {
          return {
            status: "unavailable",
            reason: "invalid_owner_evidence",
            ownerPid: owner.pid,
          };
        }
        await new Promise((resolve) =>
          setTimeout(resolve, input.pollIntervalMs),
        );
      }
      continue;
    }
    if (Date.now() >= deadline) {
      return {
        status: "unavailable",
        reason: "wait_timeout",
        ownerPid: owner.pid,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
  }
}

async function readAuthorityPathKind(
  authorityPath: string,
): Promise<"missing" | "directory" | "invalid"> {
  try {
    const stats = await lstat(authorityPath);
    return stats.isDirectory() ? "directory" : "invalid";
  } catch (error) {
    if (readNodeErrorCode(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function formatOwnerEvidence(pid: number, token: string): string {
  return `${BOOTSTRAP_AUTHORITY_VERSION}:${pid}:${token}`;
}

function parseOwnerEvidence(
  target: string,
): { pid: number; token: string } | undefined {
  const prefix = `${BOOTSTRAP_AUTHORITY_VERSION}:`;
  if (target.startsWith(prefix) === false) {
    return undefined;
  }
  const separator = target.indexOf(":", prefix.length);
  if (separator < 0) {
    return undefined;
  }
  const pid = Number.parseInt(target.slice(prefix.length, separator), 10);
  const token = target.slice(separator + 1);
  if (Number.isSafeInteger(pid) === false || pid <= 0 || token.length === 0) {
    return undefined;
  }
  return { pid, token };
}

async function readAuthorityIdentity(
  authorityPath: string,
): Promise<BootstrapAuthorityIdentity | undefined> {
  try {
    const evidencePath = ownerEvidencePath(authorityPath);
    const [stats, target] = await Promise.all([
      lstat(evidencePath),
      readlink(evidencePath),
    ]);
    if (stats.isSymbolicLink() === false) {
      return undefined;
    }
    return { device: stats.dev, inode: stats.ino, target };
  } catch (error) {
    if (
      readNodeErrorCode(error) === "ENOENT" ||
      readNodeErrorCode(error) === "ENOTDIR"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function removeAuthorityIfOwned(
  authorityPath: string,
  expected: BootstrapAuthorityIdentity,
): Promise<boolean> {
  const cleanupPath = path.join(authorityPath, "cleanup");
  let cleanupHandle;
  try {
    cleanupHandle = await open(cleanupPath, "wx");
  } catch (error) {
    if (
      readNodeErrorCode(error) === "EEXIST" ||
      readNodeErrorCode(error) === "ENOENT" ||
      readNodeErrorCode(error) === "ENOTDIR"
    ) {
      return false;
    }
    throw error;
  }

  let quarantinePath: string | undefined;
  try {
    const current = await readAuthorityIdentity(authorityPath);
    if (
      current === undefined ||
      current.device !== expected.device ||
      current.inode !== expected.inode ||
      current.target !== expected.target
    ) {
      return false;
    }
    quarantinePath = `${authorityPath}.release-${randomUUID()}`;
    try {
      await rename(authorityPath, quarantinePath);
    } catch (error) {
      if (readNodeErrorCode(error) === "ENOENT") {
        quarantinePath = undefined;
        return false;
      }
      throw error;
    }
  } finally {
    await cleanupHandle.close();
    if (quarantinePath === undefined) {
      await rm(cleanupPath, { force: true });
    } else {
      await rm(quarantinePath, { force: true, recursive: true });
    }
  }
  return true;
}

function ownerEvidencePath(authorityPath: string): string {
  return path.join(authorityPath, "owner");
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return readNodeErrorCode(error) === "EPERM";
  }
}

function readNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
