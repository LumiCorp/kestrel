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

const REPLAY_PAGE_SIZE = 500;

/**
 * Core-owned protocol journal backed by the same SQL authority as runtime
 * state. Replay is indexed by the opaque event id and streamed in sequence
 * order, so Core startup and heap use do not grow with journal history.
 */
export class LocalCoreProtocolEventJournal implements RunnerServiceEventJournal {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async ready(): Promise<void> {
    await this.executor.query("SELECT sequence FROM runner_protocol_events LIMIT 1");
  }

  async append(event: RunnerEvent): Promise<void> {
    await this.executor.query(
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
        event.id,
        event.type,
        event.ts,
        event.runId ?? null,
        event.sessionId ?? null,
        event.threadId ?? null,
        event.commandId ?? null,
        event,
      ],
    );
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
    const cursor = await this.executor.query<{ sequence: string | number }>(
      "SELECT sequence FROM runner_protocol_events WHERE event_id = $1",
      [sinceEventId],
    );
    const sequence = cursor.rows[0]?.sequence;
    if (sequence === undefined) {
      options.onReplayBoundary?.();
      return { status: "cursor_unknown" };
    }
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
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Local Core protocol journal contains an invalid event record.");
  }
  const event = parsed as Partial<RunnerEvent>;
  if (
    typeof event.id !== "string"
    || event.id.trim().length === 0
    || typeof event.type !== "string"
    || event.type.trim().length === 0
    || typeof event.ts !== "string"
    || event.ts.trim().length === 0
    || event.payload === undefined
  ) {
    throw new Error("Local Core protocol journal contains an invalid event envelope.");
  }
  return parsed as RunnerEvent;
}
