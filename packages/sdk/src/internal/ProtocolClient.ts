import { randomUUID } from "node:crypto";

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

interface PendingRequest {
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

    if (isRunnerEventEnvelope(decoded) === false) {
      return;
    }

    const event = decoded;
    for (const listener of this.listeners) {
      listener(event);
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

function isTerminalResponseEvent(type: RunnerEventType): boolean {
  return (
    type === "profile.listed" ||
    type === "profile.loaded" ||
    type === "run.completed" ||
    type === "run.failed" ||
    type === "run.cancelled" ||
    type === "runner.error" ||
    type === "runner.pong" ||
    type === "session.described" ||
    type === "session.state" ||
    type === "operator.inbox" ||
    type === "operator.thread" ||
    type === "operator.controlled" ||
    type === "task.graph" ||
    type === "workspace.checkpoint" ||
    type === "project.snapshot" ||
    type === "project.review" ||
    type === "mcp.status" ||
    type === "mcp.refreshed"
  );
}
