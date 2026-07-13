import type {
  RunnerEvent,
  RunnerEventSubscriptionFilter,
} from "../protocol/contracts.js";

export type RunnerServiceEventReplayResult =
  | { status: "ok" }
  | { status: "cursor_unknown" }
  | { status: "cursor_expired" }
  | { status: "cancelled" };

export interface RunnerServiceEventReplayOptions {
  signal?: AbortSignal | undefined;
  /** Releases live publication once the journal has captured its replay high-water mark. */
  onReplayBoundary?: (() => void) | undefined;
}

/**
 * Durable storage boundary for runner protocol events.
 *
 * Implementations must retain event order. The runner service awaits each
 * append before making the event visible to subscribers and requests replay
 * on demand so a long-lived journal does not have to be hydrated into the
 * service process heap.
 */
export interface RunnerServiceEventJournal {
  ready(): void | Promise<void>;
  append(event: RunnerEvent): void | Promise<void>;
  replayAfter(
    sinceEventId: string,
    filter: RunnerEventSubscriptionFilter,
    onEvent: (event: RunnerEvent) => void | Promise<void>,
    options?: RunnerServiceEventReplayOptions,
  ): RunnerServiceEventReplayResult | Promise<RunnerServiceEventReplayResult>;
}
