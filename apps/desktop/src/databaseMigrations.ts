import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { createDesktopError } from "./errors.js";

export interface DesktopDatabaseMigrationOptions {
  repoRoot: string;
  databaseUrl: string;
  env?: NodeJS.ProcessEnv | undefined;
  spawnImpl?: typeof spawn | undefined;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

const MAX_MIGRATION_OUTPUT_CHARS = 4_000;

export async function runDesktopDatabaseMigrations(
  options: DesktopDatabaseMigrationOptions,
): Promise<void> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(
    process.execPath,
    ["--import", "tsx", path.join(options.repoRoot, "scripts", "migrate.ts")],
    {
      cwd: options.repoRoot,
      env: resolveDesktopMigrationEnvironment(options.env ?? process.env, options.databaseUrl),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = await collectCommandResult(child);
  if (result.ok) {
    return;
  }

  throw createDesktopError({
    code: "desktop.database_migration_failed",
    message: "Kestrel Local Core database migrations failed.",
    details: summarizeMigrationFailure(result),
  });
}

export function resolveDesktopMigrationEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  databaseUrl: string,
  processVersions: NodeJS.ProcessVersions = process.versions,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    DATABASE_URL: databaseUrl,
    KESTREL_DESKTOP_APP: "1",
    ...(typeof processVersions.electron === "string" && processVersions.electron.length > 0
      ? { ELECTRON_RUN_AS_NODE: "1" }
      : {}),
  };
}

function collectCommandResult(child: ChildProcess): Promise<CommandResult> {
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

function appendOutput(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  return next.length > MAX_MIGRATION_OUTPUT_CHARS
    ? next.slice(-MAX_MIGRATION_OUTPUT_CHARS)
    : next;
}

function summarizeMigrationFailure(result: CommandResult): string {
  const combined = `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  if (combined.length > 0) {
    return combined.length > MAX_MIGRATION_OUTPUT_CHARS
      ? combined.slice(-MAX_MIGRATION_OUTPUT_CHARS)
      : combined;
  }
  return `Migration process exited with code ${result.code ?? "unknown"}.`;
}
