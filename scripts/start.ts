#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";
import {
  applyKestrelLocalEnvDefaults,
  buildDefaultKestrelDatabaseUrl,
} from "../src/config/localDev.js";

const DEFAULT_DATABASE_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_DATABASE_POLL_INTERVAL_MS = 1_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 7_000;
const MACOS_DOCKER_APP_BIN = "/Applications/Docker.app/Contents/Resources/bin/docker";

export type StartTarget = "tui" | "web";

class StartCliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "StartCliError";
    this.exitCode = exitCode;
  }
}

export interface StartArgs {
  target: StartTarget;
  skipMigrate: boolean;
}

export interface CommandSpec {
  id: string;
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
}

interface ManagedChild {
  spec: CommandSpec;
  process: ChildProcess;
}

interface EnsureDatabaseOptions {
  databaseUrl: string;
  startupTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
}

interface EnsureDatabaseResult {
  startedBySupervisor: boolean;
}

export function parseStartArgs(args: string[]): StartArgs {
  const parsed: StartArgs = {
    target: "tui",
    skipMigrate: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--target") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new StartCliError("--target requires one of: tui, web");
      }
      if (value !== "tui" && value !== "web") {
        throw new StartCliError(
          `Unknown start target '${value}'. Expected tui or web.`,
        );
      }
      parsed.target = value;
      index += 1;
      continue;
    }

    if (token === "--skip-migrate") {
      parsed.skipMigrate = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      throw new StartCliError(helpText(), 0);
    }

    throw new StartCliError(`Unknown argument '${token}'.`);
  }

  return parsed;
}

export function resolveStartCommands(target: StartTarget): CommandSpec[] {
  const pnpm = resolvePnpmCommand();
  switch (target) {
    case "tui":
      return [
        {
          id: "tui",
          label: "Kestrel TUI",
          command: process.execPath,
          args: ["--import", "tsx", path.resolve(process.cwd(), "cli/tui.ts")],
        },
      ];
    case "web":
      return [
        {
          id: "web",
          label: "Kestrel One",
          command: pnpm,
          args: ["--filter", "@kestrel/kestrel-one", "dev"],
        },
      ];
  }
}

export function isRetryableDatabaseError(error: unknown): boolean {
  const cast = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string } | undefined;
    errors?: Array<{ code?: string; message?: string }> | undefined;
  };
  const codes = new Set<string>();
  if (typeof cast.code === "string") {
    codes.add(cast.code);
  }
  if (typeof cast.cause?.code === "string") {
    codes.add(cast.cause.code);
  }
  if (Array.isArray(cast.errors)) {
    for (const item of cast.errors) {
      if (typeof item?.code === "string") {
        codes.add(item.code);
      }
    }
  }

  if (
    codes.has("ECONNREFUSED") ||
    codes.has("ECONNRESET") ||
    codes.has("ETIMEDOUT") ||
    codes.has("57P03")
  ) {
    return true;
  }

  const message = [
    typeof cast.message === "string" ? cast.message : "",
    typeof cast.cause?.message === "string" ? cast.cause.message : "",
    ...(Array.isArray(cast.errors)
      ? cast.errors.map((item) => (typeof item?.message === "string" ? item.message : ""))
      : []),
  ]
    .join(" ")
    .toLowerCase();

  return (
    message.includes("econnrefused") ||
    message.includes("connection refused") ||
    message.includes("database system is starting up") ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const args = parseStartArgs(process.argv.slice(2));
  await loadShellAndDotEnv(cwd, {
    preferDotEnvKeys: [
      "DATABASE_URL",
      "OPENROUTER_API_KEY",
      "OPENROUTER_MODEL",
      "OPENROUTER_BASE_URL",
      "OPENROUTER_SITE_URL",
      "OPENROUTER_APP_NAME",
      "TAVILY_API_KEY",
      "TAVILY_BASE_URL",
      "TAVILY_PROJECT",
      "TAVILY_HTTP_PROXY",
      "TAVILY_HTTPS_PROXY",
    ],
  });
  applyKestrelLocalEnvDefaults(process.env);

  const databaseUrl = process.env.DATABASE_URL ?? buildDefaultKestrelDatabaseUrl(process.env);
  const commandSpecs = resolveStartCommands(args.target);
  const state = {
    startedDatabase: false,
    children: [] as ManagedChild[],
    shuttingDown: false,
  };

  const shutdown = async (exitCode: number, reason?: string): Promise<void> => {
    if (state.shuttingDown) {
      return;
    }
    state.shuttingDown = true;

    if (reason !== undefined && reason.length > 0) {
      if (exitCode === 0) {
        process.stdout.write(`${reason}\n`);
      } else {
        process.stderr.write(`${reason}\n`);
      }
    }

    await stopChildren(state.children);
    if (state.startedDatabase) {
      await stopDatabase(cwd);
    }
    process.exitCode = exitCode;
  };

  process.on("SIGINT", () => {
    void shutdown(0, "Received SIGINT. Shutting down.");
  });
  process.on("SIGTERM", () => {
    void shutdown(0, "Received SIGTERM. Shutting down.");
  });

  try {
    const db = await ensureDatabase({
      databaseUrl,
    });
    state.startedDatabase = db.startedBySupervisor;

    if (args.skipMigrate === false) {
      process.stdout.write("Running database migrations...\n");
      await runCommand({
        id: "db-migrate",
        label: "database migrations",
        command: process.execPath,
        args: ["--import", "tsx", path.resolve(cwd, "scripts/migrate.ts")],
      }, cwd);
    }

    process.stdout.write(`Starting target '${args.target}'...\n`);
    await runSupervisedChildren(commandSpecs, cwd, state, shutdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await shutdown(1, `Startup failed: ${message}`);
  }
}

async function ensureDatabase(options: EnsureDatabaseOptions): Promise<EnsureDatabaseResult> {
  try {
    await pingDatabase(options.databaseUrl);
    process.stdout.write("Database is reachable.\n");
    return { startedBySupervisor: false };
  } catch (error) {
    if (isRetryableDatabaseError(error) === false) {
      throw error;
    }
  }

  process.stdout.write("Database is not reachable. Starting Postgres container...\n");
  const docker = resolveDockerCommand();
  await runCommand({
    id: "db-up",
    label: "postgres container",
    command: docker,
    args: ["compose", "up", "-d", "postgres"],
  }, process.cwd());

  const deadline = Date.now() + (options.startupTimeoutMs ?? DEFAULT_DATABASE_STARTUP_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DATABASE_POLL_INTERVAL_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await pingDatabase(options.databaseUrl);
      process.stdout.write("Database is ready.\n");
      return { startedBySupervisor: true };
    } catch (error) {
      lastError = error;
      if (isRetryableDatabaseError(error) === false) {
        throw error;
      }
      await delay(pollIntervalMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown database startup error");
  throw new Error(`Postgres did not become ready within ${Math.ceil((options.startupTimeoutMs ?? DEFAULT_DATABASE_STARTUP_TIMEOUT_MS) / 1000)}s. Last error: ${message}`);
}

async function pingDatabase(connectionString: string): Promise<void> {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 1_500,
  });

  try {
    await pool.query("SELECT 1");
  } finally {
    await pool.end();
  }
}

async function runSupervisedChildren(
  commandSpecs: CommandSpec[],
  cwd: string,
  state: { children: ManagedChild[]; shuttingDown: boolean },
  shutdown: (exitCode: number, reason?: string) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = async (exitCode: number, reason?: string) => {
      if (resolved) {
        return;
      }
      resolved = true;
      await shutdown(exitCode, reason);
      resolve();
    };

    for (const spec of commandSpecs) {
      const child = spawn(spec.command, spec.args, {
        cwd,
        stdio: "inherit",
        env: {
          ...process.env,
          ...(spec.env ?? {}),
        },
      });

      state.children.push({ spec, process: child });

      child.on("error", (error) => {
        void finish(1, `Failed to start ${spec.label}: ${error.message}`);
      });

      child.on("exit", (code, signal) => {
        state.children = state.children.filter((entry) => entry.process.pid !== child.pid);
        if (state.shuttingDown) {
          return;
        }
        if (signal !== null) {
          void finish(1, `${spec.label} exited from signal ${signal}.`);
          return;
        }
        void finish(code ?? 0, `${spec.label} exited${code === 0 || code === null ? "." : ` with code ${code}.`}`);
      });
    }
  });
}

async function stopChildren(children: ManagedChild[]): Promise<void> {
  const snapshot = [...children];
  for (const entry of snapshot) {
    await stopChild(entry);
  }
}

async function stopChild(entry: ManagedChild): Promise<void> {
  const child = entry.process;
  if (child.killed || child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve();
    };

    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, CHILD_SHUTDOWN_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });

    child.kill("SIGTERM");
  });
}

async function stopDatabase(cwd: string): Promise<void> {
  process.stdout.write("Stopping Postgres container...\n");
  await runCommand(resolveDatabaseStopCommand(resolveDockerCommand()), cwd);
}

export function resolveDatabaseStopCommand(docker: string): CommandSpec {
  return {
    id: "db-down",
    label: "postgres container shutdown",
    command: docker,
    args: ["compose", "stop", "postgres"],
  };
}

async function runCommand(spec: CommandSpec, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        ...(spec.env ?? {}),
      },
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start ${spec.label}: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${spec.label} exited from signal ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${spec.label} exited with code ${code ?? 1}.`));
        return;
      }
      resolve();
    });
  });
}

function resolvePnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function resolveDockerCommand(): string {
  return resolveDockerCommandForTests({
    env: process.env,
    platform: process.platform,
    fileExists: existsSync,
  });
}

export function resolveDockerCommandForTests(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  fileExists: (path: string) => boolean;
}): string {
  const explicit = input.env.KCHAT_DOCKER_BIN?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  if (input.platform === "win32") {
    return "docker.exe";
  }

  if (input.platform === "darwin" && input.fileExists(MACOS_DOCKER_APP_BIN)) {
    return MACOS_DOCKER_APP_BIN;
  }

  return "docker";
}

function helpText(): string {
  return [
    "Usage: pnpm start -- [--target tui|web] [--skip-migrate]",
    "",
    "Defaults:",
    "  --target tui",
  ].join("\n");
}

function isMainModule(moduleUrl: string): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  return path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

if (isMainModule(import.meta.url)) {
  void main().catch((error) => {
    if (error instanceof StartCliError) {
      const stream = error.exitCode === 0 ? process.stdout : process.stderr;
      stream.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`start failed: ${message}\n`);
    process.exitCode = 1;
  });
}
