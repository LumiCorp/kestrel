import { randomUUID } from "node:crypto";

import {
  isRunnerEventAllowedForCommand,
  isRunnerTerminalResponseEvent,
} from "@kestrel-agents/protocol";

import type {
  RunnerCommand,
  RunnerCommandMetadata,
  RunnerCommandPayloadByType,
  RunnerCommandType,
  RunnerEvent,
  RunnerEventEnvelope,
  RunnerEventType,
  RunnerResponseByCommandType,
} from "../contracts.js";
import { KestrelProtocolError, toKestrelError } from "../errors.js";
import { parseRunnerEvent } from "./runnerSse.js";

interface PendingRequest {
  commandType: RunnerCommandType;
  resolve: (event: RunnerEvent) => void;
  reject: (error: Error) => void;
}

export interface ProtocolTransport {
  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
  }): void;
  send(line: string): void;
  stop(): Promise<void>;
}

export class ProtocolClient {
  private readonly transport: ProtocolTransport;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private started = false;
  private closed = false;

  constructor(transport: ProtocolTransport) {
    this.transport = transport;
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
  ): Promise<RunnerResponseByCommandType[TType]> {
    return this.sendCommandWithId(randomUUID(), type, payload, metadata);
  }

  async sendCommandWithId<TType extends RunnerCommandType>(
    commandId: string,
    type: TType,
    payload: RunnerCommandPayloadByType[TType],
    metadata?: RunnerCommandMetadata,
  ): Promise<RunnerResponseByCommandType[TType]> {
    if (this.closed) {
      throw new KestrelProtocolError("Protocol client is closed.");
    }
    this.start();

    const command: RunnerCommand = {
      id: commandId,
      type,
      payload,
      ...(metadata !== undefined ? { metadata } : {}),
    } as RunnerCommand;

    return new Promise<RunnerResponseByCommandType[TType]>((resolve, reject) => {
      this.pending.set(commandId, {
        commandType: type,
        resolve: (event) => {
          resolve(event as RunnerResponseByCommandType[TType]);
        },
        reject,
      });
      try {
        this.transport.send(JSON.stringify(command));
      } catch (error) {
        this.pending.delete(commandId);
        reject(error instanceof Error ? error : new KestrelProtocolError(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new KestrelProtocolError("Protocol client closed before response."));
    }
    this.pending.clear();
    await this.transport.stop();
    this.listeners.clear();
  }

  private start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.transport.start({
      onLine: (line) => {
        this.onLine(line);
      },
      onExit: () => {
        this.onExit();
      },
    });
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
      const parsed = parseRunnerEvent(trimmed);
      if (parsed === undefined) {
        return;
      }
      event = parsed;
    } catch (error) {
      const protocolError = createProtocolErrorEvent(decoded, error);
      if (protocolError === undefined) {
        return;
      }
      event = protocolError;
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
      ) as RunnerEvent;
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must not prevent terminal request settlement.
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
        pending.reject(toKestrelError(event.payload));
        return;
      }
      pending.resolve(event);
    }
  }

  private onExit(): void {
    this.started = false;
    for (const pending of this.pending.values()) {
      pending.reject(new KestrelProtocolError("Protocol transport exited before response."));
    }
    this.pending.clear();
  }
}

function createProtocolErrorEvent(value: unknown, cause: unknown): RunnerEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const event = value as Record<string, unknown>;
  if (typeof event.commandId !== "string" || event.commandId.length === 0) {
    return undefined;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    id: typeof event.id === "string" && event.id.length > 0
      ? event.id
      : `runner-error-${event.commandId}`,
    type: "runner.error",
    ts: typeof event.ts === "string" && event.ts.length > 0
      ? event.ts
      : new Date().toISOString(),
    commandId: event.commandId,
    payload: {
      code: "RUNNER_PROTOCOL_INVALID",
      message: `Invalid runner event: ${detail}`,
      details: {
        eventType: typeof event.type === "string" ? event.type : "unknown",
      },
    },
  } as RunnerEvent;
}

export function isTerminalResponseEvent(type: RunnerEventType): boolean {
  return isRunnerTerminalResponseEvent(type);
}
