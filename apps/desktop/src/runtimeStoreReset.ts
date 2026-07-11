import { access, rename } from "node:fs/promises";
import path from "node:path";

import type { DesktopRuntimeStoreReset } from "../../../src/desktopShell/contracts.js";

export async function archiveRuntimeStore(
  runtimeHomePath: string,
  options: {
    now?: Date | undefined;
  } = {},
): Promise<DesktopRuntimeStoreReset> {
  const storePath = path.join(runtimeHomePath, "runtime.db");
  const resetAt = (options.now ?? new Date()).toISOString();
  if (await pathExists(storePath) === false) {
    return {
      storePath,
      resetAt,
    };
  }

  const archivedStorePath = await resolveArchivedStorePath(storePath, resetAt);
  await rename(storePath, archivedStorePath);
  return {
    storePath,
    archivedStorePath,
    resetAt,
  };
}

async function resolveArchivedStorePath(storePath: string, resetAt: string): Promise<string> {
  const base = `${storePath}.archived-${sanitizeTimestamp(resetAt)}`;
  let candidate = base;
  let suffix = 1;
  while (await pathExists(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeTimestamp(value: string): string {
  return value.replace(/[:.]/gu, "-");
}
