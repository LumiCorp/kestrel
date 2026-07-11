import { mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { DesktopProtocolTransport } from "./contracts.js";
import { createDesktopError } from "./errors.js";

export interface ManagedRunnerTransportOptions {
  repoRoot: string;
  logPath: string;
  env?: NodeJS.ProcessEnv | undefined;
  spawnImpl?: typeof spawn | undefined;
}

export interface RunnerProtocolHandlers {
  onLine: (line: string) => void;
  onExit: (code: number | null) => void;
  onErrorOutput?: ((line: string) => void) | undefined;
}

export interface RunnerProtocolObserver {
  onLine?: ((line: string) => void) | undefined;
  onExit?: ((code: number | null) => void) | undefined;
  onErrorOutput?: ((line: string) => void) | undefined;
}

export interface ManagedRunnerStatus {
  running: boolean;
  pid?: number | undefined;
  recentStdout: string[];
  recentStderr: string[];
  logPath: string;
}

export class ManagedRunnerTransport implements DesktopProtocolTransport {
  private readonly repoRoot: string;
  private readonly logPath: string;
  private env: NodeJS.ProcessEnv;
  private readonly spawnImpl: typeof spawn;
  private child: ChildProcessWithoutNullStreams | undefined;
  private handlers: RunnerProtocolHandlers | undefined;
  private stdoutReader: readline.Interface | undefined;
  private stderrReader: readline.Interface | undefined;
  private recentStdout: string[] = [];
  private recentStderr: string[] = [];
  private readonly observers = new Set<RunnerProtocolObserver>();

  constructor(options: ManagedRunnerTransportOptions) {
    this.repoRoot = options.repoRoot;
    this.logPath = options.logPath;
    this.env = options.env ?? process.env;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  setEnvironment(nextEnv: NodeJS.ProcessEnv): void {
    this.env = nextEnv;
  }

  start(handlers: RunnerProtocolHandlers): void {
    this.handlers = handlers;
    this.ensureStarted();
  }

  observe(observer: RunnerProtocolObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  ensureStarted(): void {
    if (this.child !== undefined) {
      return;
    }
    const { command, args } = resolveDesktopRunnerCommand(this.repoRoot);
    mkdirSync(path.dirname(this.logPath), { recursive: true });
    const child = this.spawnImpl(command, args, {
      cwd: this.repoRoot,
      env: resolveDesktopRunnerEnvironment(this.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stdoutReader = readline.createInterface({ input: child.stdout, terminal: false });
    this.stderrReader = readline.createInterface({ input: child.stderr, terminal: false });
    child.stdin.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.recordLine(this.recentStderr, `[runner-stdin] ${message}`, "STDERR");
      if (this.child === child && this.isChildWritable(child) === false) {
        this.child = undefined;
      }
    });
    this.stdoutReader.on("line", (line) => {
      this.recordLine(this.recentStdout, line, "STDOUT");
      this.handlers?.onLine(line);
      for (const observer of this.observers) {
        observer.onLine?.(line);
      }
    });
    this.stderrReader.on("line", (line) => {
      this.recordLine(this.recentStderr, line, "STDERR");
      this.handlers?.onErrorOutput?.(line);
      for (const observer of this.observers) {
        observer.onErrorOutput?.(line);
      }
    });
    child.on("exit", (code) => {
      this.handlers?.onExit(code);
      for (const observer of this.observers) {
        observer.onExit?.(code);
      }
      this.stdoutReader?.close();
      this.stderrReader?.close();
      this.stdoutReader = undefined;
      this.stderrReader = undefined;
      this.child = undefined;
    });
  }

  send(line: string): void {
    if (this.child === undefined || this.isChildWritable(this.child) === false) {
      throw createDesktopError({
        code: "desktop.runner_not_started",
        message: "Managed runner transport is not started.",
      });
    }
    try {
      this.child.stdin.write(`${line}\n`);
    } catch {
      throw createDesktopError({
        code: "desktop.runner_not_started",
        message: "Managed runner transport is not started.",
      });
    }
  }

  async restart(): Promise<ManagedRunnerStatus> {
    const handlers = this.handlers;
    await this.stop();
    if (handlers !== undefined) {
      this.start(handlers);
    } else {
      this.ensureStarted();
    }
    return this.getStatus();
  }

  async stop(): Promise<void> {
    if (this.child === undefined) {
      return;
    }
    const child = this.child;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }

  getStatus(): ManagedRunnerStatus {
    return {
      running: this.child !== undefined,
      ...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
      recentStdout: [...this.recentStdout],
      recentStderr: [...this.recentStderr],
      logPath: this.logPath,
    };
  }

  private recordLine(target: string[], line: string, stream: "STDOUT" | "STDERR"): void {
    const normalized = line.trim();
    if (normalized.length === 0) {
      return;
    }
    target.push(normalized);
    if (target.length > 80) {
      target.splice(0, target.length - 80);
    }
    appendFileSync(this.logPath, `[${new Date().toISOString()}] ${stream} ${normalized}\n`, "utf8");
  }

  private isChildWritable(child: ChildProcessWithoutNullStreams): boolean {
    return (
      child.killed !== true &&
      (child.exitCode === null || child.exitCode === undefined) &&
      child.stdin.destroyed === false &&
      child.stdin.writable !== false
    );
  }
}

export function resolveDesktopRunnerCommand(repoRoot: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["--import", "tsx", path.join(repoRoot, "cli", "runner", "main.ts")],
  };
}

export function resolveDesktopRunnerEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  processVersions: NodeJS.ProcessVersions = process.versions,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    KESTREL_DESKTOP_APP: "1",
    ...(typeof processVersions.electron === "string" && processVersions.electron.length > 0
      ? { ELECTRON_RUN_AS_NODE: "1" }
      : {}),
  };
}
