import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type {
  RunnerCommandEnvelope,
  RunnerCommandMetadata,
  RunnerCommandPayloadByType,
  RunnerCommandType,
  RunnerEvent,
  RunnerEventType,
} from "../protocol/contracts.js";

const protocolClientRequire = createRequire(import.meta.url);

interface PendingRequest {
  resolve: (event: RunnerEvent) => void;
  reject: (error: Error) => void;
}

export interface RunnerExitDiagnostics {
  lastProcessError?: string | undefined;
  recentStderr: string[];
}

interface ProtocolClientRunnerError extends Error {
  code?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

interface ProtocolTransport {
  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onErrorOutput?: ((line: string) => void) | undefined;
  }): void;
  send(line: string): void;
  stop(): Promise<void>;
}

export class ProtocolClient {
  private readonly transport: ProtocolTransport;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private readonly recentStderr: string[] = [];
  private started = false;
  private closed = false;
  private lastProcessError: string | undefined;

  constructor(transport: ProtocolTransport = createDefaultTransport()) {
    this.transport = transport;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.resetProcessDiagnostics();
    this.transport.start({
      onLine: (line) => {
        this.onLine(line);
      },
      onExit: (code) => {
        this.onExit(code);
      },
      onErrorOutput: (line) => {
        this.recordProcessStderr(line);
      },
    });
  }

  onEvent(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async sendCommand<TType extends RunnerCommandType>(
    type: TType,
    payload: RunnerCommandPayloadByType[TType],
    metadata?: RunnerCommandMetadata,
  ): Promise<RunnerEvent> {
    return this.sendCommandWithId(randomUUID(), type, payload, metadata);
  }

  async sendCommandWithId<TType extends RunnerCommandType>(
    commandId: string,
    type: TType,
    payload: RunnerCommandPayloadByType[TType],
    metadata?: RunnerCommandMetadata,
  ): Promise<RunnerEvent> {
    if (this.closed) {
      throw new Error("Protocol client is closed");
    }
    this.start();

    if (this.pending.has(commandId)) {
      throw new Error(`Protocol command id '${commandId}' is already in use`);
    }

    const command: RunnerCommandEnvelope<TType> = {
      id: commandId,
      type,
      payload,
      ...(metadata !== undefined ? { metadata } : {}),
    };

    const response = await new Promise<RunnerEvent>((resolve, reject) => {
      this.pending.set(commandId, { resolve, reject });
      try {
        this.transport.send(JSON.stringify(command));
      } catch (error) {
        this.pending.delete(commandId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return response;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Protocol client closed before response"));
    }
    this.pending.clear();
    await this.transport.stop();
    this.listeners.clear();
    this.resetProcessDiagnostics();
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (isRunnerEventEnvelope(decoded) === false) {
      return;
    }

    const event = decoded;
    if (event.type === "runner.error" && event.commandId === undefined) {
      this.lastProcessError = normalizeDiagnosticLine(event.payload.message);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors should not crash the protocol client.
      }
    }

    const commandId = event.commandId;
    if (commandId === undefined) {
      return;
    }

    const pending = this.pending.get(commandId);
    if (pending === undefined) {
      return;
    }

    if (isTerminalResponseEvent(event.type)) {
      this.pending.delete(commandId);
      if (event.type === "runner.error") {
        const error = new Error(event.payload.message) as ProtocolClientRunnerError;
        error.code = event.payload.code;
        error.details = event.payload.details;
        pending.reject(error);
        return;
      }

      pending.resolve(event);
    }
  }

  private onExit(code: number | null): void {
    this.started = false;
    const diagnostics = {
      lastProcessError: this.lastProcessError,
      recentStderr: this.recentStderr,
    };
    const message = buildRunnerExitMessage(code, diagnostics);
    for (const pending of this.pending.values()) {
      const error = new Error(message) as Error & {
        runnerExitDiagnostics?: RunnerExitDiagnostics | undefined;
      };
      error.runnerExitDiagnostics = {
        ...(diagnostics.lastProcessError !== undefined
          ? { lastProcessError: diagnostics.lastProcessError }
          : {}),
        recentStderr: [...diagnostics.recentStderr],
      };
      pending.reject(error);
    }
    this.pending.clear();
    this.resetProcessDiagnostics();
  }

  private recordProcessStderr(line: string): void {
    const normalized = normalizeDiagnosticLine(line);
    if (normalized.length === 0) {
      return;
    }

    this.recentStderr.push(normalized);
    if (this.recentStderr.length > MAX_RECENT_STDERR_LINES) {
      this.recentStderr.splice(0, this.recentStderr.length - MAX_RECENT_STDERR_LINES);
    }
  }

  private resetProcessDiagnostics(): void {
    this.lastProcessError = undefined;
    this.recentStderr.length = 0;
  }
}

function createDefaultTransport(): ProtocolTransport {
  const { RunnerProcess } = protocolClientRequire("./RunnerProcess.js") as typeof import("./RunnerProcess.js");
  return new RunnerProcess();
}

const MAX_RECENT_STDERR_LINES = 32;

function buildRunnerExitMessage(
  code: number | null,
  diagnostics: {
    lastProcessError?: string | undefined;
    recentStderr: string[];
  },
): string {
  const base = `Runner process exited${code === null ? "" : ` with code ${code}`}`;
  const detail = summarizeRunnerFailureDiagnostics(diagnostics);
  return detail === undefined ? base : `${base}: ${detail}`;
}

function summarizeRunnerFailureDiagnostics(diagnostics: {
  lastProcessError?: string | undefined;
  recentStderr: string[];
}): string | undefined {
  const primary = diagnostics.lastProcessError ?? pickUsefulDiagnosticLine(diagnostics.recentStderr);
  const secondary =
    diagnostics.lastProcessError !== undefined
      ? pickUsefulDiagnosticLine(
          diagnostics.recentStderr.filter((line) => line !== diagnostics.lastProcessError),
        )
      : undefined;

  if (primary === undefined) {
    return undefined;
  }
  if (secondary === undefined || primary.includes(secondary)) {
    return primary;
  }

  return `${primary} | stderr: ${secondary}`;
}

function pickUsefulDiagnosticLine(lines: string[]): string | undefined {
  const preferred = lines.find((line) =>
    /(error|exception|cannot|failed|unexpected|invalid|missing|enoent|eperm|eacces|err_)/iu.test(line),
  );
  return preferred ?? lines.find((line) => line.length > 0);
}

function normalizeDiagnosticLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isTerminalResponseEvent(type: RunnerEventType): boolean {
  return (
    type === "profile.listed" ||
    type === "profile.loaded" ||
    type === "job.completed" ||
    type === "job.failed" ||
    type === "run.completed" ||
    type === "run.failed" ||
    type === "run.cancelled" ||
    type === "runner.pong" ||
    type === "session.described" ||
    type === "session.state" ||
    type === "operator.inbox" ||
    type === "operator.thread" ||
    type === "operator.runs" ||
    type === "operator.run" ||
    type === "operator.controlled" ||
    type === "task.graph" ||
    type === "workspace.checkpoint" ||
    type === "project.snapshot" ||
    type === "project.review" ||
    type === "runner.error" ||
    type === "mcp.status" ||
    type === "mcp.refreshed"
  );
}

function isRunnerEventEnvelope(value: unknown): value is RunnerEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.type === "string" &&
    typeof record.ts === "string" &&
    record.payload !== undefined
  );
}

export type { ProtocolTransport };
