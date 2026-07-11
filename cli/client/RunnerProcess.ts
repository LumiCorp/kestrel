import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline, { type Interface as ReadLineInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveKestrelCoreHome } from "../../src/localCore/home.js";
import { shouldKeepEnvironmentDatabaseUrl } from "../localCoreEnv.js";

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export interface RunnerProcessHandlers {
  onLine: (line: string) => void;
  onExit: (code: number | null) => void;
  onErrorOutput?: ((line: string) => void) | undefined;
}

export interface RunnerProcessOptions {
  cwd?: string | undefined;
  spawnImpl?: typeof spawn | undefined;
  stopTimeoutMs?: number | undefined;
}

export class RunnerProcess {
  private readonly options: RunnerProcessOptions;
  private readonly spawnImpl: typeof spawn;
  private readonly stopTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | undefined;
  private handlers: RunnerProcessHandlers | undefined;
  private stdoutReader: ReadLineInterface | undefined;
  private stderrReader: ReadLineInterface | undefined;
  private stopPromise: Promise<void> | undefined;
  private resolveStop: (() => void) | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private childCloseListener:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;
  private childErrorListener:
    | ((error: Error) => void)
    | undefined;
  private closed = false;

  constructor(options: RunnerProcessOptions = {}) {
    this.options = options;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  start(handlers: RunnerProcessHandlers): void {
    if (this.closed) {
      throw new Error("Runner process transport is closed");
    }
    if (this.child !== undefined) {
      return;
    }

    const { command, args } = resolveRunnerCommand();
    this.handlers = handlers;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnImpl(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildRunnerEnv(process.env),
        ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
      });
    } catch (error) {
      this.emitDiagnostic(
        `Runner process failed to start: ${error instanceof Error ? error.message : String(error)}`,
        handlers,
      );
      this.handlers = undefined;
      handlers.onExit(null);
      return;
    }

    this.child = child;
    this.stdoutReader = readline.createInterface({
      input: child.stdout,
      terminal: false,
    });
    this.stdoutReader.on("line", handlers.onLine);

    this.stderrReader = readline.createInterface({
      input: child.stderr,
      terminal: false,
    });
    this.stderrReader.on("line", (line) => {
      handlers.onErrorOutput?.(line);
    });

    this.childCloseListener = (code) => {
      this.finalizeChild(child, code);
    };
    this.childErrorListener = (error) => {
      this.emitDiagnostic(
        `Runner process error: ${error instanceof Error ? error.message : String(error)}`,
        this.handlers,
      );
      this.finalizeChild(child, null);
    };
    child.once("close", this.childCloseListener);
    child.once("error", this.childErrorListener);
  }

  send(line: string): void {
    if (this.child === undefined || this.child.stdin.writable === false) {
      throw new Error("Runner process is not started");
    }

    this.child.stdin.write(`${line}\n`);
  }

  stop(): Promise<void> {
    this.closed = true;
    if (this.child === undefined) {
      this.handlers = undefined;
      return Promise.resolve();
    }
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }

    const child = this.child;
    this.stopPromise = new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });

    this.trySignalChild(child, "SIGTERM", `Runner process failed to send SIGTERM`);
    this.stopTimer = setTimeout(() => {
      if (this.child !== child) {
        return;
      }
      this.emitDiagnostic(
        `Runner process did not exit after ${this.stopTimeoutMs}ms; sending SIGKILL.`,
        this.handlers,
      );
      this.trySignalChild(child, "SIGKILL", "Runner process failed to send SIGKILL");
    }, this.stopTimeoutMs);

    return this.stopPromise;
  }

  private trySignalChild(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
    failurePrefix: string,
  ): void {
    try {
      const signalled = child.kill(signal);
      if (signalled === false) {
        this.emitDiagnostic(
          `${failurePrefix}: kill(${signal}) returned false; waiting for runner exit.`,
          this.handlers,
        );
      }
    } catch (error) {
      this.emitDiagnostic(
        `${failurePrefix}: ${error instanceof Error ? error.message : String(error)}`,
        this.handlers,
      );
    }
  }

  private finalizeChild(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child !== child) {
      return;
    }

    if (this.stopTimer !== undefined) {
      clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    if (this.childCloseListener !== undefined) {
      child.off("close", this.childCloseListener);
      this.childCloseListener = undefined;
    }
    if (this.childErrorListener !== undefined) {
      child.off("error", this.childErrorListener);
      this.childErrorListener = undefined;
    }

    this.stdoutReader?.removeAllListeners();
    this.stdoutReader?.close();
    this.stdoutReader = undefined;

    this.stderrReader?.removeAllListeners();
    this.stderrReader?.close();
    this.stderrReader = undefined;

    const handlers = this.handlers;
    this.handlers = undefined;
    this.child = undefined;

    const resolveStop = this.resolveStop;
    this.resolveStop = undefined;
    this.stopPromise = undefined;
    resolveStop?.();

    handlers?.onExit(code);
  }

  private emitDiagnostic(line: string, handlers: RunnerProcessHandlers | undefined): void {
    const normalized = line.trim();
    if (normalized.length === 0) {
      return;
    }
    handlers?.onErrorOutput?.(normalized);
  }
}

function buildRunnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const coreHome = resolveKestrelCoreHome(env, process.platform);
  const next: NodeJS.ProcessEnv = {
    ...env,
    ...(coreHome.source !== "isolated_dev_home" ? { KESTREL_CORE_HOME: coreHome.homePath } : {}),
    KESTREL_HOME: env.KESTREL_HOME?.trim() ? env.KESTREL_HOME : coreHome.homePath,
    KESTREL_RUNNER_PROCESS_ROLE: env.KESTREL_RUNNER_PROCESS_ROLE ?? "ks-runner",
    KESTREL_HEAP_DIAGNOSTICS: env.KESTREL_HEAP_DIAGNOSTICS ?? "summary",
    KESTREL_HEAP_GUARD: env.KESTREL_HEAP_GUARD ?? "warn",
  };
  if (shouldKeepEnvironmentDatabaseUrl(next) === false) {
    delete next.DATABASE_URL;
    next.KESTREL_DATABASE_URL_SOURCE = "local_core_managed";
  }
  if (next.KESTREL_HEAP_DIAGNOSTICS?.trim().toLowerCase() === "snapshot") {
    next.NODE_OPTIONS = appendNodeOption(env.NODE_OPTIONS, "--heapsnapshot-near-heap-limit=2");
  }
  return next;
}

function appendNodeOption(current: string | undefined, option: string): string {
  if (current?.split(/\s+/u).includes(option) === true) {
    return current;
  }
  return current === undefined || current.trim().length === 0
    ? option
    : `${current} ${option}`;
}

function resolveRunnerCommand(): { command: string; args: string[] } {
  const currentModulePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(currentModulePath);
  const sourceRunnerPath = path.resolve(moduleDir, "../runner/main.ts");
  const distRunnerPath = path.resolve(moduleDir, "../runner/main.js");
  const preferSourceRunner = currentModulePath.endsWith(".ts");

  if (preferSourceRunner && existsSync(sourceRunnerPath)) {
    return {
      command: process.execPath,
      args: ["--import", resolveTsxImportPath(currentModulePath), sourceRunnerPath],
    };
  }

  if (!preferSourceRunner && existsSync(distRunnerPath)) {
    return {
      command: process.execPath,
      args: [distRunnerPath],
    };
  }

  if (existsSync(sourceRunnerPath)) {
    return {
      command: process.execPath,
      args: ["--import", resolveTsxImportPath(currentModulePath), sourceRunnerPath],
    };
  }

  if (existsSync(distRunnerPath)) {
    return {
      command: process.execPath,
      args: [distRunnerPath],
    };
  }

  throw new Error(
    `Unable to resolve runner entrypoint near '${currentModulePath}'. Expected '${sourceRunnerPath}' or '${distRunnerPath}'.`,
  );
}

function resolveTsxImportPath(_modulePath?: string): string {
  const resolveImport = import.meta.resolve;
  try {
    const resolved = typeof resolveImport === "function" ? resolveImport("tsx") : undefined;
    if (typeof resolved === "string" && resolved.length > 0) {
      return resolved;
    }
  } catch {
    // Fall through to require-based resolution when import-meta resolution is unavailable.
  }
  return resolveTsxPackageImportPath();
}

function resolveTsxPackageImportPath(): string {
  const packageJsonPath = createRequire(import.meta.url).resolve("tsx/package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    exports?: {
      "."?: unknown;
    } | undefined;
  };
  const loaderExport = packageJson.exports?.["."];
  if (typeof loaderExport !== "string" || loaderExport.length === 0) {
    throw new Error(`Unable to resolve tsx loader export from '${packageJsonPath}'.`);
  }
  return pathToFileURL(path.resolve(path.dirname(packageJsonPath), loaderExport)).href;
}

export function resolveRunnerCommandForTests(input: {
  modulePath: string;
  fileExists: (path: string) => boolean;
  tsxImportPath?: string | undefined;
}): { command: string; args: string[] } {
  const moduleDir = path.dirname(input.modulePath);
  const sourceRunnerPath = path.resolve(moduleDir, "../runner/main.ts");
  const distRunnerPath = path.resolve(moduleDir, "../runner/main.js");
  const preferSourceRunner = input.modulePath.endsWith(".ts");

  if (preferSourceRunner && input.fileExists(sourceRunnerPath)) {
    return {
      command: process.execPath,
      args: ["--import", input.tsxImportPath ?? resolveTsxImportPath(input.modulePath), sourceRunnerPath],
    };
  }

  if (!preferSourceRunner && input.fileExists(distRunnerPath)) {
    return {
      command: process.execPath,
      args: [distRunnerPath],
    };
  }

  if (input.fileExists(sourceRunnerPath)) {
    return {
      command: process.execPath,
      args: ["--import", input.tsxImportPath ?? resolveTsxImportPath(input.modulePath), sourceRunnerPath],
    };
  }

  if (input.fileExists(distRunnerPath)) {
    return {
      command: process.execPath,
      args: [distRunnerPath],
    };
  }

  throw new Error(
    `Unable to resolve runner entrypoint near '${input.modulePath}'. Expected '${sourceRunnerPath}' or '${distRunnerPath}'.`,
  );
}
