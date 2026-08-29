import { lstat, rm } from "node:fs/promises";

export interface DevShellSocketIdentity {
  device: number;
  inode: number;
}

export async function readDevShellSocketIdentity(
  socketPath: string,
): Promise<DevShellSocketIdentity | undefined> {
  try {
    const stats = await lstat(socketPath);
    return { device: stats.dev, inode: stats.ino };
  } catch {
    return undefined;
  }
}

export async function removeDevShellSocketIfOwned(
  socketPath: string,
  expected: DevShellSocketIdentity,
): Promise<"removed" | "missing" | "different_owner"> {
  const current = await readDevShellSocketIdentity(socketPath);
  if (current === undefined) {
    return "missing";
  }
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode
  ) {
    return "different_owner";
  }
  await rm(socketPath, { force: true });
  return "removed";
}
