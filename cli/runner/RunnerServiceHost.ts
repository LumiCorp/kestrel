import { randomUUID } from "node:crypto";

import {
  createRunnerHealthV1,
  parseRunnerEventV2,
  type RunnerHealthV1,
} from "@kestrel-agents/protocol";

import type {
  RunnerEvent,
  RunnerEventPayloadByType,
  RunnerEventSubscriptionFilter,
  RunnerEventType,
} from "../protocol/contracts.js";
import { CommandRouter } from "./CommandRouter.js";
import { normalizeRunnerEventPayload, type RunnerEventSink } from "./EventWriter.js";
import {
  RunnerHost,
  type RunnerProfileProvider,
  type RunnerProfileSourcePolicy,
} from "./RunnerHost.js";
import type {
  RunnerServiceEventJournal,
  RunnerServiceEventReplayOptions,
  RunnerServiceEventReplayResult,
} from "./RunnerServiceEventJournal.js";

const MAX_REPLAY_HISTORY = 1000;
const MAX_LIVE_OVERLAY_HISTORY = 2000;

type RunnerEventListener = (event: RunnerEvent) => void;

interface FilteredRunnerEventListener {
  filter: RunnerEventSubscriptionFilter;
  listener: RunnerEventListener;
  unsubscribe?: (() => void) | undefined;
  onServiceClose?: (() => void) | undefined;
  closeNotified?: boolean | undefined;
}

export interface RunnerServiceHostOptions {
  runtimeFactory?: ConstructorParameters<typeof RunnerHost>[1] | undefined;
  profileProvider?: RunnerProfileProvider | undefined;
  profileSourcePolicy?: RunnerProfileSourcePolicy | undefined;
  serviceVersion: string;
  eventJournal?: RunnerServiceEventJournal | undefined;
}

export interface RunnerServiceHostCloseOptions {
  abortActiveRuns?: boolean | undefined;
}

export type RunnerServiceEventSubscriptionResult =
  | {
      status: "ok";
      unsubscribe(): void;
    }
  | Exclude<RunnerServiceEventReplayResult, { status: "ok" }>;

export class RunnerServiceEventBus implements RunnerEventSink {
  private readonly listenersByCommandId = new Map<string, Set<RunnerEventListener>>();
  private readonly subscriptionListeners = new Set<FilteredRunnerEventListener>();
  private readonly history: RunnerEvent[] = [];
  private readonly liveOverlay = new Map<string, RunnerEvent>();
  private readonly journal: RunnerServiceEventJournal | undefined;
  private readonly readiness: Promise<void>;
  private readonly activeReplayControllers = new Set<AbortController>();
  private readonly activeReplayCompletions = new Set<Promise<void>>();
  private historyEvicted = false;
  private publicationTail: Promise<void>;
  private closing = false;

  constructor(journal?: RunnerServiceEventJournal | undefined) {
    this.journal = journal;
    this.readiness = journal === undefined
      ? Promise.resolve()
      : Promise.resolve(journal.ready());
    this.publicationTail = this.readiness;
  }

  ready(): Promise<void> {
    return this.readiness;
  }

  async flush(): Promise<void> {
    await this.publicationTail;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const entry of [...this.subscriptionListeners]) {
      this.terminateFilteredSubscription(entry);
    }
    for (const controller of this.activeReplayControllers) {
      controller.abort();
    }
    await Promise.allSettled([...this.activeReplayCompletions]);
    await this.flush();
    this.listenersByCommandId.clear();
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
    const eventId = randomUUID();
    const ts = new Date().toISOString();
    let event: RunnerEvent;
    try {
      const normalizedPayload = normalizeRunnerEventPayload(type, payload);
      event = parseRunnerEventV2({
        id: eventId,
        type,
        ts,
        ...(options.runId !== undefined ? { runId: options.runId } : {}),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
        ...(options.commandId !== undefined ? { commandId: options.commandId } : {}),
        payload: normalizedPayload,
      }) as RunnerEvent;
    } catch (error) {
      const fallbackScope = normalizeRunnerEventScope(options);
      event = parseRunnerEventV2({
        id: eventId,
        type: "runner.error",
        ts,
        ...fallbackScope,
        payload: {
          code: "RUNNER_PROTOCOL_INVALID",
          message: `Runner emitted an invalid '${type}' event: ${error instanceof Error ? error.message : String(error)}`,
          details: {
            eventType: type,
          },
        },
      }) as RunnerEvent;
    }

    if (this.closing) {
      this.broadcast(event);
      return;
    }

    if (this.journal === undefined) {
      this.publish(event);
      return;
    }

    const journalEvent = options.durability === "live_only"
      ? redactLiveOnlyProtocolEvent(event)
      : event;
    if (options.durability === "live_only") {
      this.liveOverlay.set(event.id, event);
      while (this.liveOverlay.size > MAX_LIVE_OVERLAY_HISTORY) {
        const oldest = this.liveOverlay.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.liveOverlay.delete(oldest);
      }
    }
    this.publicationTail = this.publicationTail.then(async () => {
      try {
        await this.journal?.append(journalEvent);
      } catch (error) {
        this.publishJournalFailure(event, error);
        return;
      }
      this.publish(event);
    });
  }

  subscribe(commandId: string, listener: RunnerEventListener): () => void {
    const listeners = this.listenersByCommandId.get(commandId) ?? new Set<RunnerEventListener>();
    listeners.add(listener);
    this.listenersByCommandId.set(commandId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listenersByCommandId.delete(commandId);
      }
    };
  }

  async subscribeFiltered(
    filter: RunnerEventSubscriptionFilter,
    listener: RunnerEventListener,
    options: {
      signal?: AbortSignal | undefined;
      onServiceClose?: (() => void) | undefined;
    } = {},
  ): Promise<RunnerServiceEventSubscriptionResult> {
    if (this.closing || isAbortSignalSet(options.signal)) {
      return { status: "cancelled" };
    }
    if (this.journal === undefined) {
      let cursorStatus: RunnerServiceEventReplayResult;
      try {
        cursorStatus = this.replayFromMemory(filter, listener);
      } catch (error) {
        this.notifySubscriptionClose(options.onServiceClose);
        throw error;
      }
      if (cursorStatus.status !== "ok") {
        return cursorStatus;
      }
      return this.registerFilteredListener(
        filter,
        listener,
        options.onServiceClose,
      );
    }

    const replayAbortController = new AbortController();
    const forwardReplayAbort = () => replayAbortController.abort();
    options.signal?.addEventListener("abort", forwardReplayAbort, { once: true });
    this.activeReplayControllers.add(replayAbortController);
    let markReplayComplete: (() => void) | undefined;
    const replayCompletion = new Promise<void>((resolve) => {
      markReplayComplete = resolve;
    });
    this.activeReplayCompletions.add(replayCompletion);

    const bufferedEvents: RunnerEvent[] = [];
    const replayedEventIds = new Set<string>();
    const entry: FilteredRunnerEventListener = {
      filter,
      onServiceClose: options.onServiceClose,
      listener(event) {
        bufferedEvents.push(event);
      },
    };
    const deliverReplayEvent = (event: RunnerEvent) => {
      try {
        listener(event);
      } catch (error) {
        this.terminateFilteredSubscription(entry);
        throw error;
      }
    };
    this.subscriptionListeners.add(entry);
    const publicationBeforeReplay = this.publicationTail;
    let releasePublicationBoundary: (() => void) | undefined;
    let publicationBoundaryReleased = false;
    const publicationBoundary = new Promise<void>((resolve) => {
      releasePublicationBoundary = resolve;
    });
    const releaseBoundary = () => {
      if (publicationBoundaryReleased) {
        return;
      }
      publicationBoundaryReleased = true;
      releasePublicationBoundary?.();
    };
    this.publicationTail = publicationBeforeReplay.then(() => publicationBoundary);
    const unsubscribe = () => {
      releaseBoundary();
      this.subscriptionListeners.delete(entry);
      options.signal?.removeEventListener("abort", unsubscribe);
    };
    entry.unsubscribe = unsubscribe;
    options.signal?.addEventListener("abort", unsubscribe, { once: true });

    try {
      await publicationBeforeReplay;
      if (isAbortSignalSet(replayAbortController.signal)) {
        return { status: "cancelled" };
      }
      const cursorStatus = await this.replayFromJournal(filter, (event) => {
        replayedEventIds.add(event.id);
        deliverReplayEvent(event);
      }, {
        signal: replayAbortController.signal,
        onReplayBoundary: releaseBoundary,
      });
      if (cursorStatus.status !== "ok") {
        unsubscribe();
        return cursorStatus;
      }
      if (isAbortSignalSet(replayAbortController.signal)) {
        unsubscribe();
        return { status: "cancelled" };
      }
      for (const event of bufferedEvents) {
        if (replayedEventIds.has(event.id) === false) {
          deliverReplayEvent(event);
        }
      }
      entry.listener = listener;
      return { status: "ok", unsubscribe };
    } catch (error) {
      unsubscribe();
      throw error;
    } finally {
      releaseBoundary();
      this.activeReplayControllers.delete(replayAbortController);
      options.signal?.removeEventListener("abort", forwardReplayAbort);
      markReplayComplete?.();
      this.activeReplayCompletions.delete(replayCompletion);
    }
  }

  private remember(events: readonly RunnerEvent[]): void {
    if (this.journal !== undefined) {
      return;
    }
    this.history.push(...events);
    if (this.history.length > MAX_REPLAY_HISTORY) {
      this.historyEvicted = true;
      this.history.splice(0, this.history.length - MAX_REPLAY_HISTORY);
    }
  }

  private async replayFromJournal(
    filter: RunnerEventSubscriptionFilter,
    listener: RunnerEventListener,
    options: RunnerServiceEventReplayOptions,
  ): Promise<RunnerServiceEventReplayResult> {
    const sinceEventId = filter.sinceEventId;
    if (sinceEventId === undefined) {
      return { status: "ok" };
    }

    const journal = this.journal;
    if (journal === undefined) {
      throw new Error("Runner event journal is unavailable for durable replay.");
    }
    return await journal.replayAfter(
      sinceEventId,
      filter,
      (event) => {
        if (matchesSubscriptionFilter(event, filter)) {
          listener(this.liveOverlay.get(event.id) ?? event);
        }
      },
      options,
    );
  }

  private replayFromMemory(
    filter: RunnerEventSubscriptionFilter,
    listener: RunnerEventListener,
  ): RunnerServiceEventReplayResult {
    const sinceEventId = filter.sinceEventId;
    if (sinceEventId === undefined) {
      return { status: "ok" };
    }
    const cursorIndex = this.history.findIndex((event) => event.id === sinceEventId);
    if (cursorIndex < 0) {
      return {
        status: this.historyEvicted ? "cursor_expired" : "cursor_unknown",
      };
    }
    for (const event of this.history.slice(cursorIndex + 1)) {
      if (matchesSubscriptionFilter(event, filter)) {
        listener(event);
      }
    }
    return { status: "ok" };
  }

  private registerFilteredListener(
    filter: RunnerEventSubscriptionFilter,
    listener: RunnerEventListener,
    onServiceClose?: (() => void) | undefined,
  ): Extract<RunnerServiceEventSubscriptionResult, { status: "ok" }> {
    const entry: FilteredRunnerEventListener = {
      filter,
      listener,
      ...(onServiceClose !== undefined ? { onServiceClose } : {}),
    };
    this.subscriptionListeners.add(entry);
    const result: Extract<RunnerServiceEventSubscriptionResult, { status: "ok" }> = {
      status: "ok",
      unsubscribe: () => {
        this.subscriptionListeners.delete(entry);
      },
    };
    entry.unsubscribe = result.unsubscribe;
    return result;
  }

  private publish(event: RunnerEvent): void {
    this.remember([event]);
    this.broadcast(event);
  }

  private publishJournalFailure(event: RunnerEvent, error: unknown): void {
    const failure: RunnerEvent = {
      id: randomUUID(),
      type: "runner.error",
      ts: new Date().toISOString(),
      ...(event.runId !== undefined ? { runId: event.runId } : {}),
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
      ...(event.commandId !== undefined ? { commandId: event.commandId } : {}),
      payload: {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Runner event journal append failed.",
        details: {
          eventType: event.type,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    };
    this.broadcast(failure);
  }

  private broadcast(event: RunnerEvent): void {
    const commandId = event.commandId;
    if (commandId !== undefined) {
      const listeners = this.listenersByCommandId.get(commandId);
      if (listeners !== undefined) {
        for (const listener of [...listeners]) {
          try {
            listener(event);
          } catch {
            listeners.delete(listener);
          }
        }
        if (listeners.size === 0) {
          this.listenersByCommandId.delete(commandId);
        }
      }
    }

    for (const subscription of [...this.subscriptionListeners]) {
      if (matchesSubscriptionFilter(event, subscription.filter)) {
        try {
          subscription.listener(event);
        } catch {
          this.terminateFilteredSubscription(subscription);
        }
      }
    }
  }

  private terminateFilteredSubscription(
    subscription: FilteredRunnerEventListener,
  ): void {
    subscription.unsubscribe?.();
    if (subscription.closeNotified === true) {
      return;
    }
    subscription.closeNotified = true;
    this.notifySubscriptionClose(subscription.onServiceClose);
  }

  private notifySubscriptionClose(
    onServiceClose: (() => void) | undefined,
  ): void {
    try {
      onServiceClose?.();
    } catch {
      // A failed subscriber shutdown callback must not block event publication or service shutdown.
    }
  }
}

function redactLiveOnlyProtocolEvent(event: RunnerEvent): RunnerEvent {
  if (!event.type.startsWith("run.model.reasoning.")) return event;
  const payload = event.payload as unknown as Record<string, unknown>;
  const update = typeof payload.update === "object" && payload.update !== null && !Array.isArray(payload.update)
    ? payload.update as Record<string, unknown>
    : {};
  const { delta: _delta, ...metadata } = update;
  return {
    ...event,
    payload: {
      update: {
        ...metadata,
        contentState: "not_retained",
      },
    },
  } as RunnerEvent;
}

function normalizeRunnerEventScope(options: {
  runId?: string | undefined;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  commandId?: string | undefined;
}): {
  runId?: string | undefined;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  commandId?: string | undefined;
} {
  const runId = normalizeScopeValue(options.runId);
  const sessionId = normalizeScopeValue(options.sessionId);
  const threadId = normalizeScopeValue(options.threadId);
  const commandId = normalizeScopeValue(options.commandId);
  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(commandId !== undefined ? { commandId } : {}),
  };
}

function normalizeScopeValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

export class RunnerServiceHost {
  readonly events: RunnerServiceEventBus;
  readonly router: CommandRouter;
  readonly health: RunnerHealthV1;
  private readonly host: RunnerHost;

  constructor(options: RunnerServiceHostOptions) {
    this.events = new RunnerServiceEventBus(options.eventJournal);
    this.host = new RunnerHost(
      this.events,
      options.runtimeFactory,
      options.profileProvider,
      { profileSourcePolicy: options.profileSourcePolicy },
    );
    this.router = new CommandRouter(this.host, this.events);
    this.health = createRunnerHealthV1({
      serviceVersion: options.serviceVersion,
    });
  }

  ready(): Promise<void> {
    return this.events.ready();
  }

  hasActiveExecutions(): boolean {
    return this.host.hasActiveExecutions();
  }

  async close(options: RunnerServiceHostCloseOptions = {}): Promise<void> {
    try {
      await this.host.close(options);
    } finally {
      await this.events.close();
    }
  }
}

function matchesSubscriptionFilter(
  event: RunnerEvent,
  filter: RunnerEventSubscriptionFilter,
): boolean {
  if (filter.eventTypes !== undefined && filter.eventTypes.includes(event.type) === false) {
    return false;
  }
  if (filter.runId !== undefined && event.runId !== filter.runId) {
    return false;
  }
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) {
    return false;
  }
  if (filter.threadId !== undefined && event.threadId !== filter.threadId) {
    return false;
  }
  return true;
}

function isAbortSignalSet(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
