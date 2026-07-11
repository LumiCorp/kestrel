import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import type {
  RunnerEventEnvelope,
  RunnerEventPayloadByType,
  RunnerEventType,
} from "../protocol/contracts.js";

export interface RunnerEventSink {
  emit<TType extends RunnerEventType>(
    type: TType,
    payload: RunnerEventPayloadByType[TType],
    options?: {
      runId?: string | undefined;
      sessionId?: string | undefined;
      threadId?: string | undefined;
      commandId?: string | undefined;
    },
  ): void;
}

export class EventWriter implements RunnerEventSink {
  private readonly output: Writable;

  constructor(output: Writable) {
    this.output = output;
  }

  emit<TType extends RunnerEventType>(
    type: TType,
    payload: RunnerEventPayloadByType[TType],
    options: {
      runId?: string | undefined;
      sessionId?: string | undefined;
      threadId?: string | undefined;
      commandId?: string | undefined;
    } = {},
  ): void {
    const event: RunnerEventEnvelope<TType> = {
      id: randomUUID(),
      type,
      ts: new Date().toISOString(),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
      ...(options.commandId !== undefined ? { commandId: options.commandId } : {}),
      payload,
    };

    this.output.write(`${JSON.stringify(event)}\n`);
  }
}
