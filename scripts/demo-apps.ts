#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";
import {
  applyKestrelLocalEnvDefaults,
  buildDefaultKestrelDatabaseUrl,
} from "../src/config/localDev.js";

export type DemoAppId =
  | "web"
  | "docs"
  | "desktop";

export interface DemoArgs {
  apps: DemoAppId[];
  open: boolean;
  skipRootDb: boolean;
  skipRunner: boolean;
  waitTimeoutMs: number;
}

export interface DemoProcessSpec {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
  readyUrl?: string | undefined;
  kind: "support" | "app";
  allowSuccessfulExit?: boolean | undefined;
}

interface ManagedProcess {
  spec: DemoProcessSpec;
  child: ChildProcess;
}

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_HOST = "127.0.0.1";
const DEMO_RUNNER_PORT = 4010;
const DEMO_RUNNER_TOKEN = "dev-secret";
const ALL_DEMO_APPS: DemoAppId[] = [
  "web",
  "docs",
  "desktop",
];

const APP_PORTS: Record<Exclude<DemoAppId, "desktop">, number> = {
  web: 43103,
  docs: 43102,
};

class DemoCliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "DemoCliError";
    this.exitCode = exitCode;
  }
}

export function parseDemoArgs(argv: string[]): DemoArgs {
  let apps = [...ALL_DEMO_APPS];
  let open = false;
  let skipRootDb = false;
  let skipRunner = false;
  let waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--") {
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw new DemoCliError(helpText(), 0);
    }

    if (token === "--open") {
      open = true;
      continue;
    }

    if (token === "--no-desktop") {
      apps = apps.filter((app) => app !== "desktop");
      continue;
    }

    if (token === "--skip-root-db") {
      skipRootDb = true;
      continue;
    }

    if (token === "--no-runner") {
      skipRunner = true;
      continue;
    }

    if (token === "--only" || token.startsWith("--only=")) {
      const raw = readValue(argv, index, token, "--only");
      apps = parseAppList(raw);
      index += token === "--only" ? 1 : 0;
      continue;
    }

    if (token === "--skip" || token.startsWith("--skip=")) {
      const raw = readValue(argv, index, token, "--skip");
      const skipped = new Set(parseAppList(raw));
      apps = apps.filter((app) => skipped.has(app) === false);
      index += token === "--skip" ? 1 : 0;
      continue;
    }

    if (token === "--wait-ms" || token.startsWith("--wait-ms=")) {
      const raw = readValue(argv, index, token, "--wait-ms");
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) === false || parsed < 5_000) {
        throw new DemoCliError("--wait-ms must be an integer greater than or equal to 5000.");
      }
      waitTimeoutMs = parsed;
      index += token === "--wait-ms" ? 1 : 0;
      continue;
    }

    throw new DemoCliError(`Unknown argument '${token}'.`);
  }

  if (apps.length === 0) {
    throw new DemoCliError("At least one demo app must be selected.");
  }

  return {
    apps,
    open,
    skipRootDb,
    skipRunner,
    waitTimeoutMs,
  };
}

export function resolveDemoProcessSpecs(args: DemoArgs, cwd = process.cwd()): DemoProcessSpec[] {
  const pnpm = resolvePnpmCommand();
  const runnerUrl = buildLocalUrl(DEMO_RUNNER_PORT);
  const specs: DemoProcessSpec[] = [];

  if (args.skipRunner === false) {
    specs.push({
      id: "runner",
      label: "Runner Service",
      command: pnpm,
      args: ["run", "runner:service"],
      env: {
        KESTREL_RUNNER_SERVICE_HOST: DEFAULT_HOST,
        KESTREL_RUNNER_SERVICE_PORT: String(DEMO_RUNNER_PORT),
        KESTREL_RUNNER_SERVICE_TOKEN: DEMO_RUNNER_TOKEN,
      },
      url: runnerUrl,
      readyUrl: `${runnerUrl}/health`,
      kind: "support",
    });
  }

  for (const app of args.apps) {
    specs.push(resolveDemoAppSpec(app, {
      cwd,
      pnpm,
      runnerUrl,
      runnerToken: DEMO_RUNNER_TOKEN,
    }));
  }

  return specs;
}

function resolveDemoAppSpec(
  app: DemoAppId,
  input: {
    cwd: string;
    pnpm: string;
    runnerUrl: string;
    runnerToken: string;
  },
): DemoProcessSpec {
  switch (app) {
    case "web":
      return {
        id: app,
        label: "Kestrel One",
        command: input.pnpm,
        args: ["--filter", "@kestrel/kestrel-one", "dev:all"],
        env: {
          ...nextPollingEnv(),
          DEV_ALL_HOST: DEFAULT_HOST,
          DEV_ALL_PORT: String(APP_PORTS.web),
          KESTREL_RUNNER_SERVICE_URL: input.runnerUrl,
          KESTREL_RUNNER_SERVICE_TOKEN: input.runnerToken,
        },
        url: buildLocalUrl(APP_PORTS.web),
        readyUrl: `${buildLocalUrl(APP_PORTS.web)}/api/health`,
        kind: "app",
      };
    case "docs":
      return {
        id: app,
        label: "Kestrel Docs",
        command: input.pnpm,
        args: ["--filter", "@kestrel/docs", "dev"],
        env: nextPollingEnv(),
        url: buildLocalUrl(APP_PORTS.docs),
        readyUrl: buildLocalUrl(APP_PORTS.docs),
        kind: "app",
      };
    case "desktop":
      return {
        id: app,
        label: "Kestrel Desktop",
        command: input.pnpm,
        args: ["--filter", "@kestrel/desktop", "dev"],
        url: "Electron desktop app",
        kind: "app",
        allowSuccessfulExit: true,
      };
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const args = parseDemoArgs(process.argv.slice(2));
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
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? buildDefaultKestrelDatabaseUrl(process.env);

  const specs = resolveDemoProcessSpecs(args, cwd);
  await assertPortsAvailable(specs);

  if (args.skipRootDb === false) {
    await runSetupCommand("root-db", "Root Postgres", resolvePnpmCommand(), ["run", "db:up"], cwd);
    await runSetupCommand("root-db", "Root migrations", resolvePnpmCommand(), ["run", "db:migrate"], cwd);
  }

  process.stdout.write(buildStartupSummary(specs));

  const managed: ManagedProcess[] = [];
  let shuttingDown = false;
  const shutdown = async (exitCode: number, reason?: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (reason !== undefined) {
      process.stdout.write(`${reason}\n`);
    }
    await stopManagedProcesses(managed);
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown(0, "[demo] Received SIGINT. Shutting down demo apps.");
  });
  process.on("SIGTERM", () => {
    void shutdown(0, "[demo] Received SIGTERM. Shutting down demo apps.");
  });

  try {
    for (const spec of specs) {
      const child = spawnManagedProcess(spec, cwd);
      managed.push({ spec, child });
      child.once("exit", (code, signal) => {
        const managedIndex = managed.findIndex((entry) => entry.child.pid === child.pid);
        if (managedIndex >= 0) {
          managed.splice(managedIndex, 1);
        }
        if (shuttingDown) {
          return;
        }
        if (signal === null && code === 0 && spec.allowSuccessfulExit === true) {
          process.stdout.write(`[demo] ${spec.label} launched successfully.\n`);
          return;
        }
        const detail = signal !== null
          ? `${spec.label} exited from signal ${signal}.`
          : `${spec.label} exited with code ${code ?? 0}.`;
        void shutdown(code ?? 1, `[demo] ${detail}`);
      });
    }

    await waitForReadySpecs(specs, args.waitTimeoutMs);
    process.stdout.write(buildReadySummary(specs));
    if (args.open) {
      await openDemoUrls(specs);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await shutdown(1, `[demo] Startup failed: ${message}`);
    return;
  }

  await new Promise<void>(() => {});
}

async function assertPortsAvailable(specs: DemoProcessSpec[]): Promise<void> {
  const ports = new Map<number, string>();
  for (const spec of specs) {
    const port = spec.readyUrl !== undefined ? readLocalPort(spec.readyUrl) : undefined;
    if (port === undefined) {
      continue;
    }
    const existing = ports.get(port);
    if (existing !== undefined) {
      throw new DemoCliError(`${spec.label} and ${existing} both require local port ${port}.`);
    }
    ports.set(port, spec.label);
  }

  for (const [port, label] of ports) {
    await assertPortAvailable(port, label);
  }
}

async function assertPortAvailable(port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        reject(new DemoCliError(`${label} cannot start because 127.0.0.1:${port} is already in use.`));
        return;
      }
      reject(error);
    });
    server.listen(port, DEFAULT_HOST, () => {
      server.close(() => resolve());
    });
  });
}

async function runSetupCommand(
  id: string,
  label: string,
  command: string,
  commandArgs: string[],
  cwd: string,
): Promise<void> {
  process.stdout.write(`[${id}] ${label}\n`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", (error) => {
      reject(new Error(`Failed to start ${label}: ${error.message}`));
    });

    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${label} exited from signal ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${label} exited with code ${code ?? 1}.`));
        return;
      }
      resolve();
    });
  });
}

function spawnManagedProcess(spec: DemoProcessSpec, cwd: string): ChildProcess {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd ?? cwd,
    detached: process.platform !== "win32",
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(spec.env ?? {}),
    },
  });

  prefixStream(spec.id, child.stdout);
  prefixStream(spec.id, child.stderr);
  return child;
}

function prefixStream(label: string, stream: NodeJS.ReadableStream | null): void {
  if (stream === null) {
    return;
  }
  const lines = readline.createInterface({ input: stream });
  lines.on("line", (line) => {
    process.stdout.write(`[${label}] ${line}\n`);
  });
}

async function waitForReadySpecs(specs: DemoProcessSpec[], timeoutMs: number): Promise<void> {
  const readySpecs = specs.filter((spec) => spec.readyUrl !== undefined);
  await Promise.all(readySpecs.map((spec) => waitForHttpReady(spec, timeoutMs)));
}

async function waitForHttpReady(spec: DemoProcessSpec, timeoutMs: number): Promise<void> {
  if (spec.readyUrl === undefined) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(spec.readyUrl, { method: "GET" });
      if (response.status < 500) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }
    await delay(1_000);
  }
  throw new Error(`${spec.label} did not become ready at ${spec.readyUrl} within ${timeoutMs}ms.`);
}

async function openDemoUrls(specs: DemoProcessSpec[]): Promise<void> {
  if (process.platform !== "darwin") {
    process.stdout.write("[demo] --open is currently supported on macOS via the open command.\n");
    return;
  }

  const urls = specs
    .filter((spec) => spec.kind === "app")
    .map((spec) => spec.url)
    .filter((url): url is string => url !== undefined && url.startsWith("http://"));

  for (const url of urls) {
    await runSetupCommand("open", `Opening ${url}`, "open", [url], process.cwd());
  }
}

async function stopManagedProcesses(processes: ManagedProcess[]): Promise<void> {
  for (const entry of [...processes].reverse()) {
    await stopManagedProcess(entry);
  }
}

async function stopManagedProcess(entry: ManagedProcess): Promise<void> {
  const child = entry.child;
  if (child.exitCode !== null || child.killed || child.pid === undefined) {
    return;
  }

  const signalTarget = process.platform === "win32" ? child.pid : -child.pid;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(signalTarget, "SIGKILL");
      } catch {
        // Process may have already exited.
      }
      resolve();
    }, 7_000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      process.kill(signalTarget, "SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function buildStartupSummary(specs: DemoProcessSpec[]): string {
  return [
    "",
    "[demo] Starting Kestrel prospect demo stack:",
    ...specs.map((spec) => `  - ${spec.label}${spec.url !== undefined ? `: ${spec.url}` : ""}`),
    "",
  ].join("\n");
}

function buildReadySummary(specs: DemoProcessSpec[]): string {
  const appSpecs = specs.filter((spec) => spec.kind === "app");
  return [
    "",
    "[demo] Kestrel demo apps are ready:",
    ...appSpecs.map((spec) => `  - ${spec.label}: ${spec.url ?? "started"}`),
    "",
    "[demo] Press Ctrl+C to stop the demo stack.",
    "",
  ].join("\n");
}

function parseAppList(raw: string): DemoAppId[] {
  const selected = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (selected.length === 0) {
    throw new DemoCliError("App list cannot be empty.");
  }

  for (const item of selected) {
    if (isDemoAppId(item) === false) {
      throw new DemoCliError(`Unknown demo app '${item}'. Expected one of: ${ALL_DEMO_APPS.join(", ")}.`);
    }
  }

  return selected as DemoAppId[];
}

function isDemoAppId(value: string): value is DemoAppId {
  return (ALL_DEMO_APPS as string[]).includes(value);
}

function readValue(argv: string[], index: number, token: string, flag: string): string {
  if (token.startsWith(`${flag}=`)) {
    return token.slice(flag.length + 1);
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new DemoCliError(`${flag} requires a value.`);
  }
  return value;
}

function readLocalPort(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== DEFAULT_HOST && parsed.hostname !== "localhost") {
      return undefined;
    }
    return Number.parseInt(parsed.port, 10);
  } catch {
    return undefined;
  }
}

function buildLocalUrl(port: number): string {
  return `http://${DEFAULT_HOST}:${port}`;
}

function resolvePnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function nextPollingEnv(): Record<string, string> {
  return {
    WATCHPACK_POLLING: "true",
    CHOKIDAR_USEPOLLING: "true",
  };
}

function helpText(): string {
  return [
    "Usage: pnpm run demo:apps -- [options]",
    "",
    "Starts the Kestrel prospect demo stack:",
    "  web (Kestrel One), docs, desktop, and a shared runner service.",
    "",
    "Options:",
    "  --only <csv>       Start only selected apps.",
    "  --skip <csv>       Skip selected apps.",
    "  --no-desktop      Start browser apps only.",
    "  --no-runner       Do not start the shared runner service.",
    "  --skip-root-db    Do not run root Postgres startup and migrations.",
    "  --wait-ms <ms>    Readiness timeout per app. Default: 120000.",
    "  --open            Open browser app URLs after readiness.",
    "",
    `Apps: ${ALL_DEMO_APPS.join(", ")}`,
  ].join("\n");
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  void main().catch((error) => {
    if (error instanceof DemoCliError) {
      const output = error.exitCode === 0 ? process.stdout : process.stderr;
      output.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
