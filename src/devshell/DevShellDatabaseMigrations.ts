import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

export interface DevShellDatabaseMigrationOptions {
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

const MAX_MIGRATION_OUTPUT_CHARS = 4000;

export async function runDevShellDatabaseMigrations(
  options: DevShellDatabaseMigrationOptions,
): Promise<void> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(
    process.execPath,
    ["--import", "tsx", path.join(options.repoRoot, "scripts", "migrate.ts")],
    {
      cwd: options.repoRoot,
      env: resolveDevShellMigrationEnvironment(options.env ?? process.env, options.databaseUrl),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = await collectCommandResult(child);
  if (result.ok) {
    return;
  }

  throw createRuntimeFailure(
    "DEV_SHELL_MIGRATION_FAILED",
    "Developer shell database migrations failed.",
    {
      subsystem: "dev_shell",
      classification: "configuration",
      recoverable: true,
      exitCode: result.code,
      migrationOutput: summarizeMigrationFailure(result),
    },
  );
}

export function resolveDevShellMigrationEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  databaseUrl: string,
  processVersions: NodeJS.ProcessVersions = process.versions,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    DATABASE_URL: databaseUrl,
    KESTREL_DISABLE_DOTENV: "1",
    KESTREL_DEV_SHELL_SERVICE: "1",
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
  const parts = [
    `exitCode=${result.code ?? "unknown"}`,
    result.stderr.trim().length > 0 ? `stderr=${result.stderr.trim()}` : undefined,
    result.stdout.trim().length > 0 ? `stdout=${result.stdout.trim()}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join("\n");
}
