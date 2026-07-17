import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import {
  isRunnerEventAllowedForCommand,
  isRunnerTerminalResponseEvent,
  parseRunnerCommandV2,
  parseRunnerEventV2,
} from "@kestrel-agents/protocol";

import type {
  RunnerCommandEnvelope,
  RunnerCommandMetadata,
  RunnerCommandPayloadByType,
  RunnerCommandType,
  RunnerEvent,
} from "../protocol/contracts.js";

const protocolClientRequire = createRequire(import.meta.url);

interface PendingRequest {
  commandType: RunnerCommandType;
  resolve: (event: RunnerEvent) => void;
  reject: (error: Error) => void;
}

export interface RunnerExitDiagnostics {
  lastProcessError?: string | undefined;
  recentStderr: string[];
}

export interface ProtocolClientOptions {
  defaultMetadata?: RunnerCommandMetadata | undefined;
  defaultExecutionDurability?: RunnerCommandMetadata["durability"] | undefined;
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
  private readonly defaultMetadata: RunnerCommandMetadata | undefined;
  private readonly defaultExecutionDurability: RunnerCommandMetadata["durability"] | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private readonly recentStderr: string[] = [];
  private started = false;
  private closed = false;
  private lastProcessError: string | undefined;

  constructor(
    transport: ProtocolTransport = createDefaultTransport(),
    options: ProtocolClientOptions = {},
  ) {
    this.transport = transport;
    this.defaultMetadata = options.defaultMetadata;
    this.defaultExecutionDurability = options.defaultExecutionDurability;
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

    const effectiveMetadata = mergeRunnerCommandMetadata({
      defaults: this.defaultMetadata,
      command: metadata,
      executionDurability: isExecutionCommand(type)
        ? this.defaultExecutionDurability
        : undefined,
    });
    const command: RunnerCommandEnvelope<TType> = {
      id: commandId,
      type,
      payload,
      ...(effectiveMetadata !== undefined ? { metadata: effectiveMetadata } : {}),
    };
    const serializedCommand = JSON.stringify(parseRunnerCommandV2(command));

    const response = await new Promise<RunnerEvent>((resolve, reject) => {
      this.pending.set(commandId, { commandType: type, resolve, reject });
      try {
        this.transport.send(serializedCommand);
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

    let event: RunnerEvent;
    try {
      event = parseRunnerEventV2(decoded) as unknown as RunnerEvent;
    } catch (error) {
      event = createProtocolErrorEvent(decoded, error);
    }
    const correlatedPending = event.commandId === undefined
      ? undefined
      : this.pending.get(event.commandId);
    if (
      correlatedPending !== undefined
      && isRunnerEventAllowedForCommand(correlatedPending.commandType, event) === false
    ) {
      event = createProtocolErrorEvent(
        event,
        new Error(
          `Command '${correlatedPending.commandType}' received unexpected event '${event.type}'.`,
        ),
      );
    }
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

    if (isRunnerTerminalResponseEvent(event.type)) {
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

function isExecutionCommand(type: RunnerCommandType): boolean {
  return type === "run.start" || type === "job.run";
}

function mergeRunnerCommandMetadata(input: {
  defaults?: RunnerCommandMetadata | undefined;
  command?: RunnerCommandMetadata | undefined;
  executionDurability?: RunnerCommandMetadata["durability"] | undefined;
}): RunnerCommandMetadata | undefined {
  const actor = input.command?.actor ?? input.defaults?.actor;
  const tenantId = input.command?.tenantId ?? input.defaults?.tenantId;
  const profile = input.command?.profile ?? input.defaults?.profile;
  const durability = input.command?.durability
    ?? input.executionDurability
    ?? input.defaults?.durability;

  if (
    actor === undefined
    && tenantId === undefined
    && profile === undefined
    && durability === undefined
  ) {
    return ;
  }

  return {
    ...(actor !== undefined ? { actor } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(durability !== undefined ? { durability } : {}),
  };
}

function createDefaultTransport(): ProtocolTransport {
  const { createConfiguredRunnerTransport } = protocolClientRequire(
    "./configuredTransport.js",
  ) as typeof import("./configuredTransport.js");
  return createConfiguredRunnerTransport();
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
    return ;
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

function createProtocolErrorEvent(value: unknown, cause: unknown): RunnerEvent {
  const source = isRecord(value) ? value : {};
  const eventType = optionalNonEmptyString(source.type);
  const runId = optionalNonEmptyString(source.runId);
  const sessionId = optionalNonEmptyString(source.sessionId);
  const threadId = optionalNonEmptyString(source.threadId);
  const commandId = optionalNonEmptyString(source.commandId);
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    id: optionalNonEmptyString(source.id) ?? `runner-protocol-error-${randomUUID()}`,
    type: "runner.error",
    ts: optionalNonEmptyString(source.ts) ?? new Date().toISOString(),
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(commandId !== undefined ? { commandId } : {}),
    payload: {
      code: "RUNNER_PROTOCOL_INVALID",
      message: `Invalid runner event${eventType === undefined ? "" : ` '${eventType}'`}: ${detail}`,
      details: eventType === undefined ? {} : { eventType },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export type { ProtocolTransport };
