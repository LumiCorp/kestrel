import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import {
  parseRunnerEventV2,
  parseRunnerTerminalPayloadV2,
} from "@kestrel-agents/protocol";

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
      durability?: "durable" | "live_only" | undefined;
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
      durability?: "durable" | "live_only" | undefined;
    } = {},
  ): void {
    const normalizedPayload = normalizeRunnerEventPayload(type, payload);
    const event: RunnerEventEnvelope<TType> = {
      id: randomUUID(),
      type,
      ts: new Date().toISOString(),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
      ...(options.commandId !== undefined ? { commandId: options.commandId } : {}),
      payload: normalizedPayload,
    };

    this.output.write(`${JSON.stringify(parseRunnerEventV2(event))}\n`);
  }
}

export function normalizeRunnerEventPayload<TType extends RunnerEventType>(
  type: TType,
  payload: RunnerEventPayloadByType[TType],
): RunnerEventPayloadByType[TType] {
  if (type === "session.described") {
    const session = payload as RunnerEventPayloadByType["session.described"];
    return omitBlankSessionUpdatedAt(session) as RunnerEventPayloadByType[TType];
  }
  if (type === "session.state") {
    const state = payload as RunnerEventPayloadByType["session.state"];
    return {
      ...state,
      session: omitBlankSessionUpdatedAt(state.session),
    } as RunnerEventPayloadByType[TType];
  }
  if (
    type === "run.completed" ||
    type === "run.failed" ||
    type === "run.cancelled" ||
    type === "operator.controlled"
  ) {
    return parseRunnerTerminalPayloadV2(type, payload) as unknown as RunnerEventPayloadByType[TType];
  }
  return payload;
}

function omitBlankSessionUpdatedAt<T extends { updatedAt?: string | undefined }>(payload: T): T {
  if (typeof payload.updatedAt !== "string" || payload.updatedAt.trim().length > 0) {
    return payload;
  }
  const { updatedAt: _discarded, ...normalized } = payload;
  return normalized as T;
}
