import {
  EXECUTION_PROTOCOL_VERSION,
  parseRunnerEventV2,
} from "@kestrel-agents/protocol";

import type {
  RunnerEvent,
  RunnerEventSubscriptionFilter,
} from "../../cli/protocol/contracts.js";
import type {
  RunnerServiceEventJournal,
  RunnerServiceEventReplayOptions,
  RunnerServiceEventReplayResult,
} from "../../cli/runner/RunnerServiceEventJournal.js";
import type { SqlExecutor } from "../store/PostgresSessionStore.js";
import {
  LocalCoreRuntimeBindingError,
  type LocalCoreRuntimeBindingStore,
} from "./runtimeBindings.js";

const REPLAY_PAGE_SIZE = 500;

interface StoredProtocolEvent {
  executionProtocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  event: RunnerEvent;
}

/**
 * Core-owned protocol journal backed by the same SQL authority as runtime
 * state. Replay is indexed by the opaque event id and streamed in sequence
 * order, so Core startup and heap use do not grow with journal history.
 */
export class LocalCoreProtocolEventJournal implements RunnerServiceEventJournal {
  private readonly executor: SqlExecutor;

  constructor(
    executor: SqlExecutor,
    private readonly runtimeBindings?: LocalCoreRuntimeBindingStore,
  ) {
    this.executor = executor;
  }

  async ready(): Promise<void> {
    await this.executor.query("SELECT sequence FROM runner_protocol_events LIMIT 1");
  }

  async append(event: RunnerEvent): Promise<void> {
    const parsed = parseRunnerEventV2(event) as RunnerEvent;
    if (this.runtimeBindings !== undefined) {
      await this.runtimeBindings.transaction(async (bindings, executor) => {
        await this.applyRuntimeBindingEvent(parsed, bindings);
        await appendProtocolEvent(executor, parsed);
      });
      return;
    }
    await appendProtocolEvent(this.executor, parsed);
  }

  private async applyRuntimeBindingEvent(
    event: RunnerEvent,
    bindings: LocalCoreRuntimeBindingStore,
  ): Promise<void> {
    if (event.type === "run.native_session.established") {
      const binding = await bindings.getForRunnerSession(event.payload.sessionId);
      if (binding === undefined) {
        throw new LocalCoreRuntimeBindingError(
          "RUNTIME_BINDING_NOT_FOUND",
          "Native-session establishment has no authoritative Local Core binding.",
        );
      }
      await bindings.establish({
        canonicalThreadId: binding.canonicalThreadId,
        bindingId: event.payload.bindingId,
        participantId: event.payload.participantId,
        runtimeId: event.payload.runtimeId,
        environmentId: binding.environmentId,
      });
      return;
    }
    if (event.type === "runtime.released") {
      const binding = await bindings.get(event.payload.threadId);
      if (binding === undefined) {
        throw new LocalCoreRuntimeBindingError(
          "RUNTIME_BINDING_NOT_FOUND",
          "Runtime release has no authoritative Local Core binding.",
        );
      }
      await bindings.release({
        canonicalThreadId: binding.canonicalThreadId,
        bindingId: event.payload.bindingId,
        participantId: event.payload.participantId,
        runtimeId: event.payload.runtimeId,
        environmentId: event.payload.environmentId,
        acknowledgementEventId: event.id,
      });
      return;
    }
    if (event.type !== "run.failed") return;
    const code = readRuntimeFailureCode(event.payload.error);
    if (
      code !== "RUNTIME_NATIVE_SESSION_LOST" &&
      code !== "RUNTIME_LIVE_WAIT_LOST"
    ) return;
    if (event.sessionId === undefined) {
      throw new LocalCoreRuntimeBindingError(
        "RUNTIME_BINDING_CORRELATION_INVALID",
        "Runtime loss has no canonical Desktop Thread correlation.",
      );
    }
    const binding = await bindings.getForRunnerSession(event.sessionId);
    if (binding === undefined) {
      throw new LocalCoreRuntimeBindingError(
        "RUNTIME_BINDING_NOT_FOUND",
        "Runtime loss has no authoritative Local Core binding.",
      );
    }
    if (binding.runtimeId === "kestrel") {
      throw new LocalCoreRuntimeBindingError(
        "RUNTIME_BINDING_CORRELATION_INVALID",
        "A foreign Runtime loss cannot be applied to a Kestrel binding.",
      );
    }
    await bindings.degrade({
      canonicalThreadId: binding.canonicalThreadId,
      bindingId: binding.bindingId,
      participantId: binding.participantId,
      runtimeId: binding.runtimeId,
      environmentId: binding.environmentId,
      lossCode: code,
    });
  }

  async findTerminalEvent(
    filter: RunnerEventSubscriptionFilter,
  ): Promise<RunnerEvent | null> {
    if (filter.runId === undefined) {
      return null;
    }
    const conditions = [
      "run_id = $1",
      "event_type IN ('run.completed', 'run.failed', 'run.cancelled')",
    ];
    const values: unknown[] = [filter.runId];
    appendFilterCondition(conditions, values, "session_id", filter.sessionId);
    appendFilterCondition(conditions, values, "thread_id", filter.threadId);
    const result = await this.executor.query<{ event_json: unknown }>(
      `SELECT event_json
         FROM runner_protocol_events
        WHERE ${conditions.join(" AND ")}
        ORDER BY sequence DESC
        LIMIT 1`,
      values,
    );
    const value = result.rows[0]?.event_json;
    return value === undefined || !isCurrentProtocolEvent(value)
      ? null
      : parseRunnerEventJson(value);
  }

  async replayAfter(
    sinceEventId: string,
    filter: RunnerEventSubscriptionFilter,
    onEvent: (event: RunnerEvent) => void | Promise<void>,
    options: RunnerServiceEventReplayOptions = {},
  ): Promise<RunnerServiceEventReplayResult> {
    if (isAbortSignalSet(options.signal)) {
      options.onReplayBoundary?.();
      return { status: "cancelled" };
    }
    const cursor = await this.executor.query<{
      sequence: string | number;
      event_json: unknown;
    }>(
      "SELECT sequence, event_json FROM runner_protocol_events WHERE event_id = $1",
      [sinceEventId],
    );
    const cursorRow = cursor.rows[0];
    if (cursorRow === undefined) {
      options.onReplayBoundary?.();
      return { status: "cursor_unknown" };
    }
    if (!isCurrentProtocolEvent(cursorRow.event_json)) {
      options.onReplayBoundary?.();
      return { status: "cursor_expired" };
    }
    const sequence = cursorRow.sequence;
    if (isAbortSignalSet(options.signal)) {
      options.onReplayBoundary?.();
      return { status: "cancelled" };
    }

    const highWatermark = await this.executor.query<{
      sequence: string | number | null;
    }>("SELECT MAX(sequence) AS sequence FROM runner_protocol_events");
    const replayThroughSequence = highWatermark.rows[0]?.sequence ?? sequence;
    options.onReplayBoundary?.();

    let replaySequence = sequence;
    while (true) {
      if (isAbortSignalSet(options.signal)) {
        return { status: "cancelled" };
      }
      const conditions = ["sequence > $1", "sequence <= $2"];
      const values: unknown[] = [replaySequence, replayThroughSequence];
      appendFilterCondition(conditions, values, "run_id", filter.runId);
      appendFilterCondition(conditions, values, "session_id", filter.sessionId);
      appendFilterCondition(conditions, values, "thread_id", filter.threadId);
      if (filter.eventTypes !== undefined) {
        if (filter.eventTypes.length === 0) {
          conditions.push("FALSE");
        } else {
          const placeholders = filter.eventTypes.map((eventType) => {
            values.push(eventType);
            return `$${values.length}`;
          });
          conditions.push(`event_type IN (${placeholders.join(", ")})`);
        }
      }
      values.push(REPLAY_PAGE_SIZE);
      const replay = await this.executor.query<{
        sequence: string | number;
        event_json: unknown;
      }>(
        `SELECT sequence, event_json
           FROM runner_protocol_events
          WHERE ${conditions.join(" AND ")}
          ORDER BY sequence ASC
          LIMIT $${values.length}`,
        values,
      );
      for (const row of replay.rows) {
        if (isAbortSignalSet(options.signal)) {
          return { status: "cancelled" };
        }
        await onEvent(parseRunnerEventJson(row.event_json));
      }
      const lastSequence = replay.rows.at(-1)?.sequence;
      if (lastSequence === undefined || replay.rows.length < REPLAY_PAGE_SIZE) {
        break;
      }
      replaySequence = lastSequence;
    }
    return { status: "ok" };
  }
}

async function appendProtocolEvent(
  executor: SqlExecutor,
  parsed: RunnerEvent,
): Promise<void> {
  await executor.query(
    `INSERT INTO runner_protocol_events (
       event_id,
       event_type,
       occurred_at,
       run_id,
       session_id,
       thread_id,
       command_id,
       event_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      parsed.id,
      parsed.type,
      parsed.ts,
      parsed.runId ?? null,
      parsed.sessionId ?? null,
      parsed.threadId ?? null,
      parsed.commandId ?? null,
      {
        executionProtocolVersion: EXECUTION_PROTOCOL_VERSION,
        event: parsed,
      } satisfies StoredProtocolEvent,
    ],
  );
}

function readRuntimeFailureCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function appendFilterCondition(
  conditions: string[],
  values: unknown[],
  column: "run_id" | "session_id" | "thread_id",
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }
  values.push(value);
  conditions.push(`${column} = $${values.length}`);
}

function isAbortSignalSet(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function parseRunnerEventJson(value: unknown): RunnerEvent {
  return parseStoredProtocolEvent(value).event;
}

function isCurrentProtocolEvent(value: unknown): boolean {
  try {
    parseStoredProtocolEvent(value);
    return true;
  } catch {
    return false;
  }
}

function parseStoredProtocolEvent(value: unknown): StoredProtocolEvent {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || !("executionProtocolVersion" in parsed)
    || parsed.executionProtocolVersion !== EXECUTION_PROTOCOL_VERSION
    || !("event" in parsed)
  ) {
    throw new Error(
      `runner protocol journal entry must use ${EXECUTION_PROTOCOL_VERSION}`,
    );
  }
  return {
    executionProtocolVersion: EXECUTION_PROTOCOL_VERSION,
    event: parseRunnerEventV2(parsed.event) as RunnerEvent,
  };
}
