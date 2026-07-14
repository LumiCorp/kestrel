import { randomUUID } from "node:crypto";

import type { LocalCoreClient } from "../../../src/localCore/client.js";
import type { LocalCoreConnectionManager } from "../../../src/localCore/connectionManager.js";
import type { DesktopProtocolTransport, DesktopRuntimeStatus } from "./contracts.js";
import type { RunnerProtocolObserver } from "./runnerTransport.js";

export interface DesktopRunnerControlTransport extends DesktopProtocolTransport {
  ensureStarted(): void;
  observe(observer: RunnerProtocolObserver): () => void;
  restart(): Promise<DesktopRuntimeStatus>;
  getStatus(): DesktopRuntimeStatus;
}

export class LocalCoreRunnerTransport implements DesktopRunnerControlTransport {
  private readonly connectionManager: Pick<LocalCoreConnectionManager, "executeOnce">;
  private readonly logPath: string;
  private readonly controllers = new Map<string, AbortController>();
  private readonly observers = new Set<RunnerProtocolObserver>();
  private handlers:
    | {
        onLine: (line: string) => void;
        onExit: (code: number | null) => void;
        onErrorOutput?: ((line: string) => void) | undefined;
      }
    | undefined;
  private started = false;
  private recentStderr: string[] = [];

  constructor(input: {
    connectionManager: Pick<LocalCoreConnectionManager, "executeOnce">;
    logPath: string;
  }) {
    this.connectionManager = input.connectionManager;
    this.logPath = input.logPath;
  }

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onErrorOutput?: ((line: string) => void) | undefined;
  }): void {
    this.handlers = handlers;
    this.started = true;
  }

  ensureStarted(): void {
    this.started = true;
  }

  observe(observer: RunnerProtocolObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  send(line: string): void {
    if (!this.started) {
      throw new Error("Local Core runner transport is not started.");
    }
    const commandId = readCommandId(line);
    const controller = new AbortController();
    this.controllers.set(commandId, controller);
    void this.connectionManager.executeOnce(async (client) => await client.sendRunnerCommand(line, {
      signal: controller.signal,
      onLine: (eventLine) => this.emitLine(eventLine),
    })).catch((error: unknown) => {
      if (controller.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.recordError(message);
      this.emitLine(JSON.stringify({
        id: randomUUID(),
        type: "runner.error",
        commandId,
        payload: {
          code: "LOCAL_CORE_RUNNER_TRANSPORT_ERROR",
          message,
        },
      }));
    }).finally(() => {
      this.controllers.delete(commandId);
    });
  }

  async restart(): Promise<DesktopRuntimeStatus> {
    this.abortActiveRequests();
    await this.connectionManager.executeOnce(async (client) => await client.restart());
    this.started = true;
    return this.getStatus();
  }

  async stop(): Promise<void> {
    this.abortActiveRequests();
    this.started = false;
  }

  getStatus(): DesktopRuntimeStatus {
    return {
      running: this.started,
      recentStdout: [],
      recentStderr: [...this.recentStderr],
      logPath: this.logPath,
    };
  }

  private abortActiveRequests(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }

  private emitLine(line: string): void {
    this.handlers?.onLine(line);
    for (const observer of this.observers) {
      observer.onLine?.(line);
    }
  }

  private recordError(message: string): void {
    this.recentStderr.push(message);
    if (this.recentStderr.length > 80) {
      this.recentStderr = this.recentStderr.slice(-80);
    }
    this.handlers?.onErrorOutput?.(message);
    for (const observer of this.observers) {
      observer.onErrorOutput?.(message);
    }
  }
}

function readCommandId(line: string): string {
  const decoded = JSON.parse(line) as { id?: unknown };
  if (typeof decoded.id !== "string" || decoded.id.length === 0) {
    throw new Error("Local Core runner command must include an id.");
  }
  return decoded.id;
}
