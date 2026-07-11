import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveKestrelHomePath } from "../runtime/kestrelHome.js";

export const DEV_SHELL_SOCKET_FILE = "supervisor.sock";
export const DEV_SHELL_LOG_FILE = "service.log";
export const DEV_SHELL_BOOTSTRAP_STATUS_FILE = "bootstrap-status.json";

const DARWIN_MAX_UNIX_SOCKET_PATH_BYTES = 103;
const DEFAULT_MAX_UNIX_SOCKET_PATH_BYTES = 107;
const SHORT_BASE_DIR = "kds";

export function resolveDefaultDevShellBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return ensureSocketPathCapacity(path.join(resolveKestrelHomePath(env), "dev-shell"));
}

export function resolveDefaultDevShellSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDefaultDevShellBaseDir(env), DEV_SHELL_SOCKET_FILE);
}

export function resolveDefaultDevShellLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDefaultDevShellBaseDir(env), DEV_SHELL_LOG_FILE);
}

export function resolveDefaultDevShellBootstrapStatusPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDefaultDevShellBaseDir(env), DEV_SHELL_BOOTSTRAP_STATUS_FILE);
}

function ensureSocketPathCapacity(baseDir: string): string {
  if (Buffer.byteLength(path.join(baseDir, DEV_SHELL_SOCKET_FILE), "utf8") <= maxUnixSocketPathBytes()) {
    return baseDir;
  }
  return path.join(tmpdir(), SHORT_BASE_DIR, shortHash(baseDir, 12));
}

function maxUnixSocketPathBytes(): number {
  return process.platform === "darwin"
    ? DARWIN_MAX_UNIX_SOCKET_PATH_BYTES
    : DEFAULT_MAX_UNIX_SOCKET_PATH_BYTES;
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
