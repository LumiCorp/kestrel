import { lstat, rm } from "node:fs/promises";

export interface DevShellSocketObservation {
  device: bigint;
  inode: bigint;
  changeTimeNanoseconds: bigint;
  birthTimeNanoseconds: bigint;
  mode: bigint;
  isSocket: boolean;
}

export async function readDevShellSocketObservation(
  socketPath: string,
): Promise<DevShellSocketObservation | undefined> {
  try {
    const stats = await lstat(socketPath, { bigint: true });
    return {
      device: stats.dev,
      inode: stats.ino,
      changeTimeNanoseconds: stats.ctimeNs,
      birthTimeNanoseconds: stats.birthtimeNs,
      mode: stats.mode,
      isSocket: stats.isSocket(),
    };
  } catch (error) {
    if (readNodeErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function removeDevShellSocketIfUnchanged(
  socketPath: string,
  expected: DevShellSocketObservation,
): Promise<"removed" | "missing" | "changed"> {
  const current = await readDevShellSocketObservation(socketPath);
  if (current === undefined) {
    return "missing";
  }
  if (isSameDevShellSocketObservation(current, expected) === false) {
    return "changed";
  }
  await rm(socketPath, { force: true });
  return "removed";
}

export function isSameDevShellSocketObservation(
  left: DevShellSocketObservation | undefined,
  right: DevShellSocketObservation | undefined,
): boolean {
  return left !== undefined &&
    right !== undefined &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.changeTimeNanoseconds === right.changeTimeNanoseconds &&
    left.birthTimeNanoseconds === right.birthTimeNanoseconds &&
    left.mode === right.mode &&
    left.isSocket === right.isSocket;
}

function readNodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
