import assert from "node:assert/strict";
import test from "node:test";

import type { TuiProfile } from "../../cli/contracts.js";
import type { DelegationTaskUpdate } from "../../cli/runtime/KestrelChatRuntime.js";
import { createInMemoryRunnerService, createRunnerServiceServer } from "../../cli/runner/RunnerService.js";
import type { RunnerServiceEventJournal } from "../../cli/runner/RunnerServiceEventJournal.js";
import { RunnerServiceEventBus } from "../../cli/runner/RunnerServiceHost.js";
import type { RunnerRuntime } from "../../cli/runner/RunnerHost.js";
import type {
  RunnerEvent,
  RunnerEventSubscriptionFilter,
} from "../../cli/protocol/contracts.js";
import type { ProgressUpdateV1, ReasoningUpdateV1, RunLogEntry } from "../../src/index.js";

const profile: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

async function readStreamBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  timeoutMessage: string,
): Promise<string> {
  assert.ok(reader);
  const chunk = await Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), 5000);
    }),
  ]);
  return new TextDecoder().decode(chunk.value);
}

async function withTestTimeout<T>(
  promise: Promise<T>,
  timeoutMessage: string,
  timeoutMs = 5000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

class MemoryRunnerServiceEventJournal implements RunnerServiceEventJournal {
  readonly events: RunnerEvent[] = [];

  ready(): void {}

  async replayAfter(
    sinceEventId: string,
    filter: RunnerEventSubscriptionFilter,
    onEvent: (event: RunnerEvent) => void | Promise<void>,
    options: {
      signal?: AbortSignal | undefined;
      onReplayBoundary?: (() => void) | undefined;
    } = {},
  ) {
    if (isAbortSignalSet(options.signal)) {
      return { status: "cancelled" as const };
    }
    const cursorIndex = this.events.findIndex((event) => event.id === sinceEventId);
    if (cursorIndex < 0) {
      options.onReplayBoundary?.();
      return { status: "cursor_unknown" as const };
    }
    options.onReplayBoundary?.();
    for (const event of this.events.slice(cursorIndex + 1)) {
      if (isAbortSignalSet(options.signal)) {
        return { status: "cancelled" as const };
      }
      if (matchesTestSubscriptionFilter(event, filter)) {
        await onEvent(event);
      }
    }
    return { status: "ok" as const };
  }

  async append(event: RunnerEvent): Promise<void> {
    await Promise.resolve();
    this.events.push(event);
  }
}

test("live reasoning reconnects in-process but restarts with redacted metadata", async () => {
  const journal = new MemoryRunnerServiceEventJournal();
  const bus = new RunnerServiceEventBus(journal);
  bus.emit("runner.pong", { nonce: "cursor" }, { runId: "run-reasoning-replay" });
  await bus.flush();
  const cursor = journal.events[0]!;
  bus.emit("run.model.reasoning.delta", {
    update: {
      version: "v1",
      runId: "run-reasoning-replay",
      sessionId: "session-reasoning-replay",
      ts: new Date().toISOString(),
      seq: 2,
      event: "delta",
      attempt: 1,
      format: "summary",
      delta: "Live provider summary.",
      contentState: "live",
    },
  }, { runId: "run-reasoning-replay", sessionId: "session-reasoning-replay", durability: "live_only" });
  await bus.flush();

  const sameProcess: RunnerEvent[] = [];
  await bus.subscribeFiltered({ runId: "run-reasoning-replay", sinceEventId: cursor.id }, (event) => sameProcess.push(event));
  assert.equal(sameProcess.length, 1);
  assert.equal((sameProcess[0]?.payload as { update?: { delta?: string } }).update?.delta, "Live provider summary.");

  const restarted = new RunnerServiceEventBus(journal);
  const afterRestart: RunnerEvent[] = [];
  await restarted.subscribeFiltered({ runId: "run-reasoning-replay", sinceEventId: cursor.id }, (event) => afterRestart.push(event));
  assert.equal(afterRestart.length, 1);
  const update = (afterRestart[0]?.payload as { update?: { delta?: string; contentState?: string } }).update;
  assert.equal(update?.delta, undefined);
  assert.equal(update?.contentState, "not_retained");
});

test("journal-backed replay queries durable history beyond the in-memory history cap", async () => {
  const journal = new MemoryRunnerServiceEventJournal();
  for (let index = 0; index < 1002; index += 1) {
    journal.events.push({
      id: `seed-event-${index}`,
      type: "runner.pong",
      ts: new Date(index).toISOString(),
      runId: "run-seeded-journal",
      payload: {
        nonce: `nonce-${index}`,
      },
    });
  }
  const eventBus = new RunnerServiceEventBus(journal);
  await eventBus.ready();
  const replayed: RunnerEvent[] = [];
  const subscription = await eventBus.subscribeFiltered({
    runId: "run-seeded-journal",
    sinceEventId: "seed-event-0",
  }, (event) => {
    replayed.push(event);
  });

  try {
    assert.equal(subscription.status, "ok");
    assert.equal(replayed.length, 1001);
    assert.equal(replayed[0]?.id, "seed-event-1");
    assert.equal(replayed.at(-1)?.id, "seed-event-1001");
  } finally {
    if (subscription.status === "ok") {
      subscription.unsubscribe();
    }
    await eventBus.flush();
  }
});

test("journal replay and live publication share one ordered subscription boundary", async () => {
  const seedCursor: RunnerEvent = {
    id: "seed-race-cursor",
    type: "runner.pong",
    ts: new Date(0).toISOString(),
    runId: "run-replay-race",
    payload: { nonce: "cursor" },
  };
  const seedReplay: RunnerEvent = {
    id: "seed-race-replay",
    type: "runner.pong",
    ts: new Date(1).toISOString(),
    runId: "run-replay-race",
    payload: { nonce: "replay" },
  };
  let allowReplay: (() => void) | undefined;
  const replayGate = new Promise<void>((resolve) => {
    allowReplay = resolve;
  });
  let markReplayStarted: (() => void) | undefined;
  const replayStarted = new Promise<void>((resolve) => {
    markReplayStarted = resolve;
  });
  const journal = new MemoryRunnerServiceEventJournal();
  journal.events.push(seedCursor, seedReplay);
  journal.replayAfter = async (sinceEventId, filter, onEvent, options) => {
    assert.equal(sinceEventId, seedCursor.id);
    assert.equal(filter.runId, "run-replay-race");
    markReplayStarted?.();
    options?.onReplayBoundary?.();
    await replayGate;
    await onEvent(seedReplay);
    return { status: "ok" };
  };
  const eventBus = new RunnerServiceEventBus(journal);
  await eventBus.ready();
  const received: RunnerEvent[] = [];
  const subscriptionPromise = eventBus.subscribeFiltered({
    runId: "run-replay-race",
    sinceEventId: seedCursor.id,
  }, (event) => {
    received.push(event);
  });

  await replayStarted;
  let markLivePublished: (() => void) | undefined;
  const livePublished = new Promise<void>((resolve) => {
    markLivePublished = resolve;
  });
  const unsubscribeLive = eventBus.subscribe("cmd-replay-race-live", () => {
    markLivePublished?.();
  });
  eventBus.emit("runner.pong", { nonce: "live" }, {
    runId: "run-replay-race",
    commandId: "cmd-replay-race-live",
  });
  await livePublished;
  allowReplay?.();
  const subscription = await subscriptionPromise;
  assert.equal(subscription.status, "ok");
  await eventBus.flush();

  assert.deepEqual(received.map((event) => event.payload), [
    { nonce: "replay" },
    { nonce: "live" },
  ]);
  if (subscription.status === "ok") {
    subscription.unsubscribe();
  }
  unsubscribeLive();
});

test("durable replay cancellation removes its provisional listener", async () => {
  const seedCursor: RunnerEvent = {
    id: "seed-cancel-cursor",
    type: "runner.pong",
    ts: new Date(0).toISOString(),
    runId: "run-replay-cancel",
    payload: { nonce: "cursor" },
  };
  let markReplayStarted: (() => void) | undefined;
  const replayStarted = new Promise<void>((resolve) => {
    markReplayStarted = resolve;
  });
  let allowReplay: (() => void) | undefined;
  const replayGate = new Promise<void>((resolve) => {
    allowReplay = resolve;
  });
  const journal = new MemoryRunnerServiceEventJournal();
  journal.events.push(seedCursor);
  journal.replayAfter = async (_sinceEventId, _filter, _onEvent, options) => {
    markReplayStarted?.();
    options?.onReplayBoundary?.();
    await replayGate;
    return isAbortSignalSet(options?.signal)
      ? { status: "cancelled" }
      : { status: "ok" };
  };
  const eventBus = new RunnerServiceEventBus(journal);
  await eventBus.ready();
  const controller = new AbortController();
  const received: RunnerEvent[] = [];
  const subscriptionPromise = eventBus.subscribeFiltered({
    runId: "run-replay-cancel",
    sinceEventId: seedCursor.id,
  }, (event) => {
    received.push(event);
  }, { signal: controller.signal });

  await replayStarted;
  controller.abort();
  eventBus.emit("runner.pong", { nonce: "after-cancel" }, {
    runId: "run-replay-cancel",
  });
  allowReplay?.();

  assert.deepEqual(await subscriptionPromise, { status: "cancelled" });
  await eventBus.flush();
  assert.deepEqual(received, []);
});

test("runner event bus close aborts and drains active durable replay", async () => {
  const seedCursor: RunnerEvent = {
    id: "seed-close-cursor",
    type: "runner.pong",
    ts: new Date(0).toISOString(),
    runId: "run-replay-close",
    payload: { nonce: "cursor" },
  };
  let markReplayStarted: (() => void) | undefined;
  const replayStarted = new Promise<void>((resolve) => {
    markReplayStarted = resolve;
  });
  let markAbortObserved: (() => void) | undefined;
  const abortObserved = new Promise<void>((resolve) => {
    markAbortObserved = resolve;
  });
  let releaseReplayCleanup: (() => void) | undefined;
  const replayCleanup = new Promise<void>((resolve) => {
    releaseReplayCleanup = resolve;
  });
  const journal = new MemoryRunnerServiceEventJournal();
  journal.events.push(seedCursor);
  journal.replayAfter = async (_sinceEventId, _filter, _onEvent, options) => {
    markReplayStarted?.();
    options?.onReplayBoundary?.();
    if (options?.signal?.aborted !== true) {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    markAbortObserved?.();
    await replayCleanup;
    return { status: "cancelled" };
  };
  const eventBus = new RunnerServiceEventBus(journal);
  await eventBus.ready();
  const subscriptionPromise = eventBus.subscribeFiltered({
    runId: "run-replay-close",
    sinceEventId: seedCursor.id,
  }, () => {
    assert.fail("closing replay must not publish an event");
  });

  await replayStarted;
  let closeSettled = false;
  const closePromise = eventBus.close().then(() => {
    closeSettled = true;
  });
  await abortObserved;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  releaseReplayCleanup?.();
  assert.deepEqual(await subscriptionPromise, { status: "cancelled" });
  await closePromise;
  assert.equal(closeSettled, true);
});

test("bounded in-memory replay reports an expired cursor after eviction", async () => {
  const eventBus = new RunnerServiceEventBus();
  let firstEventId: string | undefined;
  const unsubscribe = eventBus.subscribe("cmd-retention", (event) => {
    firstEventId ??= event.id;
  });
  for (let index = 0; index < 1001; index += 1) {
    eventBus.emit("runner.pong", { nonce: `retention-${index}` }, {
      commandId: "cmd-retention",
    });
  }
  unsubscribe();
  assert.ok(firstEventId);

  const subscription = await eventBus.subscribeFiltered({
    runId: "run-retention",
    sinceEventId: firstEventId,
  }, () => {
    assert.fail("an expired cursor must not replay retained events");
  });

  assert.deepEqual(subscription, { status: "cursor_expired" });
});

test("runner events are appended to an injected journal before subscribers receive them", async () => {
  let appendCompleted = false;
  const eventBus = new RunnerServiceEventBus({
    ready() {},
    async append() {
      await Promise.resolve();
      appendCompleted = true;
    },
    replayAfter() {
      return { status: "cursor_unknown" };
    },
  });
  await eventBus.ready();
  let received = false;
  const unsubscribe = eventBus.subscribe("cmd-journal-order", () => {
    assert.equal(appendCompleted, true);
    received = true;
  });

  try {
    eventBus.emit("runner.pong", { nonce: "journal-order" }, {
      commandId: "cmd-journal-order",
    });
    assert.equal(received, false);
    await eventBus.flush();
    assert.equal(received, true);
  } finally {
    unsubscribe();
  }
});

test("subscriber failures do not poison durable event publication", async () => {
  const journal = new MemoryRunnerServiceEventJournal();
  const eventBus = new RunnerServiceEventBus(journal);
  await eventBus.ready();
  const received: RunnerEvent[] = [];
  eventBus.subscribe("cmd-listener-isolation", () => {
    throw new Error("subscriber failed");
  });
  const unsubscribe = eventBus.subscribe("cmd-listener-isolation", (event) => {
    received.push(event);
  });

  try {
    eventBus.emit("runner.pong", { nonce: "first" }, {
      commandId: "cmd-listener-isolation",
    });
    await eventBus.flush();
    eventBus.emit("runner.pong", { nonce: "second" }, {
      commandId: "cmd-listener-isolation",
    });
    await eventBus.flush();

    assert.deepEqual(received.map((event) => event.payload), [
      { nonce: "first" },
      { nonce: "second" },
    ]);
    assert.deepEqual(journal.events.map((event) => event.payload), [
      { nonce: "first" },
      { nonce: "second" },
    ]);
  } finally {
    unsubscribe();
    await eventBus.close();
  }
});

test("filtered subscriber failure terminates and removes the subscription", async () => {
  const journal = new MemoryRunnerServiceEventJournal();
  const eventBus = new RunnerServiceEventBus(journal);
  await eventBus.ready();
  let listenerCalls = 0;
  let closeCalls = 0;
  const subscription = await eventBus.subscribeFiltered({
    runId: "run-filtered-listener-failure",
  }, () => {
    listenerCalls += 1;
    throw new Error("filtered subscriber failed");
  }, {
    onServiceClose() {
      closeCalls += 1;
    },
  });
  assert.equal(subscription.status, "ok");

  eventBus.emit("runner.pong", { nonce: "first" }, {
    runId: "run-filtered-listener-failure",
  });
  await eventBus.flush();
  eventBus.emit("runner.pong", { nonce: "after-removal" }, {
    runId: "run-filtered-listener-failure",
  });
  await eventBus.flush();

  assert.equal(listenerCalls, 1);
  assert.equal(closeCalls, 1);
  await eventBus.close();
  assert.equal(closeCalls, 1);
});

test("filtered replay failure terminates the subscription owner", async () => {
  const journal = new MemoryRunnerServiceEventJournal();
  journal.events.push(
    {
      id: "filtered-replay-cursor",
      type: "runner.pong",
      ts: new Date(0).toISOString(),
      runId: "run-filtered-replay-failure",
      payload: { nonce: "cursor" },
    },
    {
      id: "filtered-replay-event",
      type: "runner.pong",
      ts: new Date(1).toISOString(),
      runId: "run-filtered-replay-failure",
      payload: { nonce: "replayed" },
    },
  );
  const eventBus = new RunnerServiceEventBus(journal);
  await eventBus.ready();
  let closeCalls = 0;

  await assert.rejects(
    () => eventBus.subscribeFiltered({
      runId: "run-filtered-replay-failure",
      sinceEventId: "filtered-replay-cursor",
    }, () => {
      throw new Error("replay subscriber failed");
    }, {
      onServiceClose() {
        closeCalls += 1;
      },
    }),
    /replay subscriber failed/u,
  );
  assert.equal(closeCalls, 1);
  await eventBus.close();
  assert.equal(closeCalls, 1);
});

test("journal append failures do not poison later event publication", async () => {
  const journal = new MemoryRunnerServiceEventJournal();
  let rejectNextAppend = true;
  journal.append = async (event) => {
    if (rejectNextAppend) {
      rejectNextAppend = false;
      throw new Error("journal unavailable");
    }
    journal.events.push(event);
  };
  const eventBus = new RunnerServiceEventBus(journal);
  await eventBus.ready();
  const received: RunnerEvent[] = [];
  const unsubscribe = eventBus.subscribe("cmd-journal-recovery", (event) => {
    received.push(event);
  });

  try {
    eventBus.emit("runner.pong", { nonce: "not-durable" }, {
      commandId: "cmd-journal-recovery",
    });
    await eventBus.flush();
    eventBus.emit("runner.pong", { nonce: "durable" }, {
      commandId: "cmd-journal-recovery",
    });
    await eventBus.flush();

    assert.equal(received[0]?.type, "runner.error");
    assert.match(
      received[0]?.type === "runner.error" ? received[0].payload.message : "",
      /journal append failed/u,
    );
    assert.deepEqual(received[1]?.payload, { nonce: "durable" });
    assert.deepEqual(journal.events.map((event) => event.payload), [
      { nonce: "durable" },
    ]);
  } finally {
    unsubscribe();
    await eventBus.close();
  }
});

function matchesTestSubscriptionFilter(
  event: RunnerEvent,
  filter: RunnerEventSubscriptionFilter,
): boolean {
  return (
    (filter.runId === undefined || event.runId === filter.runId)
    && (filter.sessionId === undefined || event.sessionId === filter.sessionId)
    && (filter.threadId === undefined || event.threadId === filter.threadId)
    && (filter.eventTypes === undefined || filter.eventTypes.includes(event.type))
  );
}

function isAbortSignalSet(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

test("runner service requires actor metadata", async () => {
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-1",
        type: "runner.ping",
        payload: {
          nonce: "ok",
        },
      }),
    });

    const event = JSON.parse(response.body) as { type: string; payload: { message: string } };
    assert.equal(response.statusCode, 400);
    assert.equal(event.type, "runner.error");
    assert.match(event.payload.message, /actor metadata is required/i);
  } finally {
    await service.close();
  }
});

test("runner service rejects unknown command discriminants at the protocol boundary", async () => {
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("unknown commands must not reach the runtime");
      },
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-unknown-discriminant",
        type: "runner.unsupported",
        metadata: {
          actor: {
            actorId: "test-operator",
            actorType: "operator",
          },
        },
        payload: {},
      }),
    });

    const event = JSON.parse(response.body) as {
      type: string;
      payload: { code: string; message: string };
    };
    assert.equal(response.statusCode, 400);
    assert.equal(event.type, "runner.error");
    assert.equal(event.payload.code, "INVALID_COMMAND");
  } finally {
    await service.close();
  }
});

test("runner service rejects malformed command envelopes at the protocol boundary", async () => {
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("malformed commands must not reach the runtime");
      },
      close: async () => {},
    }),
  });

  try {
    for (const body of [
      JSON.stringify({ id: "cmd-missing-payload", type: "runner.ping" }),
      JSON.stringify({ id: " ", type: "runner.ping", payload: {} }),
    ]) {
      const response = await service.dispatch({
        method: "POST",
        url: "/commands",
        headers: {
          "content-type": "application/json",
        },
        body,
      });
      const event = JSON.parse(response.body) as {
        type: string;
        payload: { code: string };
      };
      assert.equal(response.statusCode, 400);
      assert.equal(event.type, "runner.error");
      assert.equal(event.payload.code, "INVALID_COMMAND");
    }
  } finally {
    await service.close();
  }
});

test("runner service routes run.start and job.run through the canonical streaming boundary", async () => {
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("wrong-route commands must not reach the runtime");
      },
      close: async () => {},
    }),
  });
  const metadata = {
    actor: {
      actorId: "test-operator",
      actorType: "operator",
    },
  };

  try {
    const commands = [
      {
        id: "cmd-run-start-wrong-route",
        type: "run.start",
        metadata,
        payload: {
          profile,
          turn: {
            sessionId: "session-run-start-wrong-route",
            message: "hello",
            eventType: "user.message",
          },
        },
      },
      {
        id: "cmd-job-run-wrong-route",
        type: "job.run",
        metadata,
        payload: {
          profile,
          input: {
            version: "job_input_v1",
            turn: {
              sessionId: "session-job-run-wrong-route",
              message: "run unattended",
              eventType: "job.run",
            },
          },
        },
      },
    ];

    for (const command of commands) {
      const response = await service.dispatch({
        method: "POST",
        url: "/commands",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
      });
      const event = JSON.parse(response.body) as {
        type: string;
        payload: { message: string };
      };
      assert.equal(response.statusCode, 400);
      assert.equal(event.type, "runner.error");
      assert.match(event.payload.message, /must use \/commands\/stream/i);
    }
  } finally {
    await service.close();
  }
});

test("runner service enforces bearer auth when configured", async () => {
  const service = createInMemoryRunnerService({
    authToken: "secret-token",
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-2",
        type: "runner.ping",
        metadata: {
          actor: {
            actorId: "alice",
            actorType: "operator",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
        payload: {
          nonce: "ok",
        },
      }),
    });

    const event = JSON.parse(response.body) as { type: string; payload: { message: string } };
    assert.equal(response.statusCode, 401);
    assert.equal(event.type, "runner.error");
    assert.match(event.payload.message, /authorization is required/i);
  } finally {
    await service.close();
  }
});

test("runner service rejects malformed actor metadata with a structured error", async () => {
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-invalid-actor",
        type: "runner.ping",
        metadata: {
          actor: {
            actorId: 123,
            actorType: "end_user",
          },
        },
        payload: {
          nonce: "ok",
        },
      }),
    });

    const event = JSON.parse(response.body) as { type: string; payload: { message: string } };
    assert.equal(response.statusCode, 400);
    assert.equal(event.type, "runner.error");
    assert.match(event.payload.message, /actorId.*non-empty string/i);
  } finally {
    await service.close();
  }
});

test("runner service exposes profiles and resolves profileId for run.start", async () => {
  let capturedProfileId: string | undefined;
  const service = createInMemoryRunnerService({
    profileProvider: {
      async listProfiles() {
        return [profile];
      },
      async getProfile(profileId) {
        return profileId === profile.id ? profile : undefined;
      },
    },
    runtimeFactory: (resolvedProfile) => ({
      runTurn: async () => {
        capturedProfileId = resolvedProfile.id;
        return {
          assistantText: "  profile response  ",
          output: {
            status: "COMPLETED",
            sessionId: "session-profile-id",
            runId: "run-profile-id",
            errors: [],
            quality: {
              citationCoverage: 1,
              unresolvedClaims: 0,
              reworkRate: 0,
              thrashIndex: 0,
            },
            telemetry: {
              stepsExecuted: 1,
              toolCalls: 0,
              modelCalls: 0,
              durationMs: 1,
            },
          },
        };
      },
      close: async () => {},
    }),
  });

  try {
    const metadata = {
      actor: {
        actorId: "alice",
        actorType: "operator" as const,
      },
    };

    const listed = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-profile-list",
        type: "profile.list",
        metadata,
        payload: {},
      }),
    });
    const listedEvent = JSON.parse(listed.body) as {
      type: string;
      payload: { profiles: Array<{ id: string }> };
    };
    assert.equal(listed.statusCode, 200);
    assert.equal(listedEvent.type, "profile.listed");
    assert.deepEqual(listedEvent.payload.profiles.map((item) => item.id), ["reference"]);

    const runResponse = await service.dispatch({
      method: "POST",
      url: "/commands/stream",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-run-profile-id",
        type: "run.start",
        metadata,
        payload: {
          profileId: "reference",
          turn: {
            sessionId: "session-profile-id",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });
    assert.equal(runResponse.statusCode, 200);
    assert.match(runResponse.body, /event: run\.completed/);
    assert.match(runResponse.body, /"assistantText":"profile response"/u);
    assert.doesNotMatch(runResponse.body, / {2}profile response {2}/u);
    assert.equal(capturedProfileId, "reference");
  } finally {
    await service.close();
  }
});

test("runner service settles an invalid job terminal without a journal", async () => {
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => ({
        assistantText: "   ",
        finalizedPayload: null,
        output: {
          status: "COMPLETED",
          sessionId: "session-invalid-job-terminal",
          runId: "run-invalid-job-terminal",
          errors: [],
          quality: {
            citationCoverage: 1,
            unresolvedClaims: 0,
            reworkRate: 0,
            thrashIndex: 0,
          },
          telemetry: {
            stepsExecuted: 1,
            toolCalls: 0,
            modelCalls: 0,
            durationMs: 1,
          },
        },
      }),
      close: async () => {},
    }),
  });

  try {
    const response = await withTestTimeout(
      service.dispatch({
        method: "POST",
        url: "/commands/stream",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "cmd-invalid-job-terminal",
          type: "job.run",
          metadata: {
            actor: {
              actorId: "test-operator",
              actorType: "operator",
            },
          },
          payload: {
            profile,
            input: {
              version: "job_input_v1",
              turn: {
                sessionId: "session-invalid-job-terminal",
                message: "return an invalid job terminal",
                eventType: "job.run",
              },
            },
          },
        }),
      }),
      "invalid job terminal stream did not settle",
      1000,
    );

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: runner\.error/u);
    assert.match(response.body, /"commandId":"cmd-invalid-job-terminal"/u);
    assert.match(response.body, /"code":"RUNNER_PROTOCOL_INVALID"/u);
    assert.match(response.body, /assistantText/u);
    assert.doesNotMatch(response.body, /event: job\.completed/u);
  } finally {
    await service.close();
  }
});

test("runner service settles an invalid runtime scope without a journal", async () => {
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => ({
        assistantText: "Finished.",
        finalizedPayload: null,
        output: {
          status: "COMPLETED",
          sessionId: "session-invalid-runtime-scope",
          runId: "   ",
          errors: [],
          quality: {
            citationCoverage: 1,
            unresolvedClaims: 0,
            reworkRate: 0,
            thrashIndex: 0,
          },
          telemetry: {
            stepsExecuted: 1,
            toolCalls: 0,
            modelCalls: 0,
            durationMs: 1,
          },
        },
      }),
      close: async () => {},
    }),
  });

  try {
    const response = await withTestTimeout(
      service.dispatch({
        method: "POST",
        url: "/commands/stream",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "cmd-invalid-runtime-scope",
          type: "run.start",
          metadata: {
            actor: {
              actorId: "test-operator",
              actorType: "operator",
            },
          },
          payload: {
            profile,
            turn: {
              sessionId: "session-invalid-runtime-scope",
              message: "return an invalid runtime scope",
              eventType: "user.message",
            },
          },
        }),
      }),
      "invalid runtime scope stream did not settle",
      1000,
    );

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: runner\.error/u);
    assert.match(response.body, /"commandId":"cmd-invalid-runtime-scope"/u);
    assert.match(response.body, /"code":"RUNNER_PROTOCOL_INVALID"/u);
    assert.doesNotMatch(response.body, /"runId":"\s*"/u);
    assert.doesNotMatch(response.body, /event: run\.completed/u);
  } finally {
    await service.close();
  }
});

test("runner service streams run events and preserves issuedBy for operator actions", async () => {
  let logListener: ((entry: RunLogEntry) => void) | undefined;
  let progressListener: ((update: ProgressUpdateV1) => void) | undefined;
  let reasoningListener: ((update: ReasoningUpdateV1) => void) | undefined;
  let taskUpdateListener: ((update: DelegationTaskUpdate) => void) | undefined;
  let capturedIssuedBy: string | undefined;

  const runtimeFactory = (): RunnerRuntime => ({
    runTurn: async () => {
      taskUpdateListener?.({
        kind: "waiting",
        assistantText: null,
        task: {
          taskId: "task-1",
          parentSessionId: "session-1",
          title: "Wait for operator input",
          status: "WAITING",
          childSessionId: "child-session-1",
          childSessionName: "Child Session",
          profileId: "reference",
          provider: "openrouter",
          model: "openai/gpt-5.4",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      logListener?.({
        runId: "run-123",
        sessionId: "session-1",
        eventName: "step_started",
        level: "INFO",
      });
      progressListener?.({
        version: "v1",
        runId: "run-123",
        sessionId: "session-1",
        ts: new Date().toISOString(),
        seq: 1,
        kind: "stage",
        phase: "engine",
        code: "RUN_STARTED",
        message: "Run started.",
        persist: true,
      });
      reasoningListener?.({
        version: "v1",
        runId: "run-123",
        sessionId: "session-1",
        ts: new Date().toISOString(),
        seq: 1,
        milestone: "phase_changed",
        message: "Reasoning in progress.",
      });
      return {
        assistantText: "The streamed runner turn completed.",
        output: {
          status: "COMPLETED",
          sessionId: "session-1",
          runId: "run-123",
          errors: [],
          quality: {
            citationCoverage: 1,
            unresolvedClaims: 0,
            reworkRate: 0,
            thrashIndex: 0,
          },
          telemetry: {
            stepsExecuted: 1,
            toolCalls: 0,
            modelCalls: 0,
            durationMs: 1,
          },
        },
      };
    },
    performOperatorAction: async (input) => {
      capturedIssuedBy = input.issuedBy;
      return {
        threadId: input.threadId,
      };
    },
    close: async () => {},
  });

  const service = createInMemoryRunnerService({
    authToken: "secret-token",
    runtimeFactory: (_profile, onRunLog, onProgress, _onConsole, onReasoning, onTaskUpdate) => {
      logListener = onRunLog;
      progressListener = onProgress;
      reasoningListener = onReasoning;
      taskUpdateListener = onTaskUpdate;
      return runtimeFactory();
    },
  });

  try {
    const metadata = {
      actor: {
        actorId: "alice",
        actorType: "operator",
        displayName: "Alice",
        tenantId: "internal",
      },
      tenantId: "internal",
    };

    const runResponse = await service.dispatch({
      method: "POST",
      url: "/commands/stream",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-run-1",
        type: "run.start",
        metadata: {
          ...metadata,
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-1",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });

    const sseBody = runResponse.body;
    assert.equal(runResponse.statusCode, 200);
    assert.match(sseBody, /"type":"run\.started"/);
    assert.match(sseBody, /"type":"run\.completed"/);
    assert.doesNotMatch(sseBody, /"type":"task\.updated"/);
    assert.match(sseBody, /"sessionId":"session-1"/);

    const controlResponse = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-control-1",
        type: "operator.control",
        metadata: {
          ...metadata,
          profile,
        },
        payload: {
          action: "retry",
          threadId: "thread-1",
        },
      }),
    });

    const controlEvent = JSON.parse(controlResponse.body) as { type: string };
    assert.equal(controlEvent.type, "operator.controlled");
    assert.equal(capturedIssuedBy, "Alice");
  } finally {
    await service.close();
  }
});

test("in-memory runner service cancels active runs when a streaming dispatch is aborted", async () => {
  let aborted = false;
  let resolveRunTurnEntered: (() => void) | undefined;
  const runTurnEntered = new Promise<void>((resolve) => {
    resolveRunTurnEntered = resolve;
  });
  let resolveAborted: (() => void) | undefined;
  const abortedPromise = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async (_input, options) => {
        resolveRunTurnEntered?.();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            resolveAborted?.();
            resolve();
          }, { once: true });
        });
        throw Object.assign(new Error("cancelled"), { code: "RUN_CANCELLED" });
      },
      close: async () => {},
    }),
  });

  try {
    const metadata = {
      actor: {
        actorId: "alice",
        actorType: "operator" as const,
        tenantId: "internal",
      },
      tenantId: "internal",
    };
    const controller = new AbortController();
    const responsePromise = service.dispatch({
      method: "POST",
      url: "/commands/stream",
      headers: {
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        id: "cmd-in-memory-stream-disconnect",
        type: "run.start",
        metadata,
        payload: {
          profile,
          turn: {
            sessionId: "session-in-memory-disconnect",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });

    await runTurnEntered;
    controller.abort();
    await Promise.race([
      abortedPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for in-memory run cancellation")), 2000);
      }),
    ]);

    const response = await responsePromise;
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: run\.cancelled/);
    assert.doesNotMatch(response.body, /event: run\.failed/);
    assert.equal(aborted, true);
  } finally {
    await service.close();
  }
});

test("in-memory runner service resolves cleanly when a streaming dispatch is already aborted before start", async () => {
  let runTurnCalled = false;
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => {
        runTurnCalled = true;
        throw new Error("should not run");
      },
      close: async () => {},
    }),
  });

  try {
    const metadata = {
      actor: {
        actorId: "alice",
        actorType: "operator" as const,
        tenantId: "internal",
      },
      tenantId: "internal",
    };
    const controller = new AbortController();
    controller.abort();

    const response = await Promise.race([
      service.dispatch({
        method: "POST",
        url: "/commands/stream",
        headers: {
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          id: "cmd-in-memory-stream-pre-aborted",
          type: "run.start",
          metadata,
          payload: {
            profile,
            turn: {
              sessionId: "session-pre-aborted",
              message: "hello",
              eventType: "user.message",
            },
          },
        }),
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for pre-aborted in-memory dispatch")), 2000);
      }),
    ]);

    assert.equal(response.statusCode, 200);
    assert.equal(runTurnCalled, false);
    assert.equal(response.body, "");
  } finally {
    await service.close();
  }
});

test("runner service streams filtered subscription events over /events/stream", async () => {
  const server = await createRunnerServiceServer({
    runtimeFactory: (_profile, _onRunLog, _onProgress, _onConsole, _onReasoning, onTaskUpdate) => ({
      runTurn: async () => {
        onTaskUpdate({
          kind: "waiting",
          assistantText: null,
          task: {
            taskId: "task-subscribe-1",
            parentSessionId: "session-subscribe",
            title: "Wait for operator input",
            status: "WAITING",
            childSessionId: "child-session-1",
            childSessionName: "Child Session",
            profileId: "reference",
            provider: "openrouter",
            model: "openai/gpt-5.4",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });
        return {
          assistantText: null,
          output: {
            status: "COMPLETED",
            sessionId: "session-subscribe",
            runId: "run-subscribe",
            errors: [],
            quality: {
              citationCoverage: 1,
              unresolvedClaims: 0,
              reworkRate: 0,
              thrashIndex: 0,
            },
            telemetry: {
              stepsExecuted: 1,
              toolCalls: 0,
              modelCalls: 0,
              durationMs: 1,
            },
          },
        };
      },
      close: async () => {},
    }),
  });

  try {
    const subscription = await fetch(`${server.url}/events/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        filter: {
          sessionId: "session-subscribe",
          eventTypes: ["task.updated"],
        },
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
      }),
    });

    assert.equal(subscription.status, 200);
    const reader = subscription.body?.getReader();

    const commandResponse = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-run-subscribe",
        type: "run.start",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-subscribe",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });
    assert.equal(commandResponse.status, 200);

    const firstChunk = await Promise.race([
      reader?.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for durable start event")), 2000);
      }),
    ]);
    const body = new TextDecoder().decode(firstChunk?.value);
    assert.match(body, /"type":"task\.updated"/);
    assert.match(body, /"sessionId":"session-subscribe"/);

    await reader?.cancel();
    await commandResponse.text();
  } finally {
    await server.close();
  }
});

test("runner service graceful close ends open event subscriptions", async () => {
  const server = await createRunnerServiceServer();
  let gracefullyClosed = false;

  try {
    const subscription = await fetch(`${server.url}/events/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        filter: {
          runId: "run-graceful-close-subscription",
        },
        metadata: {
          actor: {
            actorId: "graceful-close-test",
            actorType: "service",
          },
        },
      }),
    });
    assert.equal(subscription.status, 200);
    const reader = subscription.body?.getReader();
    assert.ok(reader);

    const closePromise = server.gracefulClose().then(() => {
      gracefullyClosed = true;
    });
    const finalRead = await withTestTimeout(
      reader.read(),
      "timed out waiting for graceful close to end the event subscription",
    );
    assert.equal(finalRead.done, true);
    await withTestTimeout(
      closePromise,
      "timed out waiting for runner service graceful close",
    );
  } finally {
    if (gracefullyClosed === false) {
      await server.forceClose();
    }
  }
});

test("runner service cancels active runs when a stream disconnects", async () => {
  let aborted = false;
  let resolveRunTurnEntered: (() => void) | undefined;
  const runTurnEntered = new Promise<void>((resolve) => {
    resolveRunTurnEntered = resolve;
  });
  let resolveAborted: (() => void) | undefined;
  const abortedPromise = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  const server = await createRunnerServiceServer({
    runtimeFactory: () => ({
      runTurn: async (_input, options) => {
        resolveRunTurnEntered?.();
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            aborted = true;
            resolveAborted?.();
            resolve();
          };
          options?.signal?.addEventListener("abort", onAbort, { once: true });
        });
        return {
          assistantText: null,
          output: {
            status: "COMPLETED",
            sessionId: "session-disconnect",
            runId: "run-disconnect",
            errors: [],
            quality: {
              citationCoverage: 1,
              unresolvedClaims: 0,
              reworkRate: 0,
              thrashIndex: 0,
            },
            telemetry: {
              stepsExecuted: 1,
              toolCalls: 0,
              modelCalls: 0,
              durationMs: 1,
            },
          },
        };
      },
      close: async () => {},
    }),
  });

  try {
    const controller = new AbortController();
    const response = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-stream-disconnect",
        type: "run.start",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-disconnect",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    await runTurnEntered;
    await reader?.read();
    await reader?.cancel();
    controller.abort();

    await Promise.race([
      abortedPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for run cancellation")), 2000);
      }),
    ]);

    assert.equal(aborted, true);
  } finally {
    await server.close();
  }
});

test("runner service keeps durable runs active when a stream disconnects", async () => {
  let aborted = false;
  let resolveRunTurnEntered: (() => void) | undefined;
  const runTurnEntered = new Promise<void>((resolve) => {
    resolveRunTurnEntered = resolve;
  });
  let resolveRunTurn: (() => void) | undefined;
  const finishRunTurn = new Promise<void>((resolve) => {
    resolveRunTurn = resolve;
  });

  const server = await createRunnerServiceServer({
    runtimeFactory: () => ({
      runTurn: async (_input, options) => {
        resolveRunTurnEntered?.();
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          resolveRunTurn?.();
        }, { once: true });
        await finishRunTurn;
        return {
          assistantText: "The durable runner turn completed.",
          output: {
            status: "COMPLETED",
            sessionId: "session-durable-disconnect",
            runId: "run-durable-disconnect",
            errors: [],
            quality: {
              citationCoverage: 1,
              unresolvedClaims: 0,
              reworkRate: 0,
              thrashIndex: 0,
            },
            telemetry: {
              stepsExecuted: 1,
              toolCalls: 0,
              modelCalls: 0,
              durationMs: 1,
            },
          },
        };
      },
      close: async () => {},
    }),
  });

  try {
    const controller = new AbortController();
    const response = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-durable-disconnect",
        type: "run.start",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
          durability: "continue_on_disconnect",
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-durable-disconnect",
            runId: "run-durable-disconnect",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    await runTurnEntered;
    const firstChunk = await Promise.race([
      reader?.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for durable start event")), 2000);
      }),
    ]);
    const firstBody = new TextDecoder().decode(firstChunk?.value);
    assert.match(firstBody, /"runId":"run-durable-disconnect"/);
    const startedEventId = /"id":"([^"]+)"/u.exec(firstBody)?.[1];
    assert.ok(startedEventId);
    await reader?.cancel();
    controller.abort();

    const unknownCursor = await fetch(`${server.url}/events/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        filter: {
          runId: "run-durable-disconnect",
          sinceEventId: "missing-cursor",
        },
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
      }),
    });
    assert.equal(unknownCursor.status, 409);
    const unknownCursorBody = await unknownCursor.text();
    assert.match(unknownCursorBody, /"type":"runner\.error"/);
    assert.match(unknownCursorBody, /"code":"RUNNER_EVENT_CURSOR_UNKNOWN"/);
    assert.doesNotMatch(unknownCursorBody, /"type":"run\.started"/);

    const replay = await fetch(`${server.url}/events/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        filter: {
          runId: "run-durable-disconnect",
          sinceEventId: startedEventId,
        },
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
      }),
    });
    assert.equal(replay.status, 200);
    const replayReader = replay.body?.getReader();

    resolveRunTurn?.();
    const replayCompletedBody = await readStreamBodyChunk(
      replayReader,
      "timed out waiting for durable completion event",
    );
    assert.match(replayCompletedBody, /"type":"run\.completed"/);
    assert.match(replayCompletedBody, /"runId":"run-durable-disconnect"/);
    assert.equal(aborted, false);
    await replayReader?.cancel();
  } finally {
    await server.close();
  }
});

test("runner service replays journaled events from sinceEventId after host recreation", async () => {
  const journal = new MemoryRunnerServiceEventJournal();
  const runtimeFactory = () => ({
    runTurn: async () => ({
      assistantText: "durable replay complete",
      output: {
        status: "COMPLETED" as const,
        sessionId: "session-journal-replay",
        runId: "run-journal-replay",
        errors: [],
        quality: {
          citationCoverage: 1,
          unresolvedClaims: 0,
          reworkRate: 0,
          thrashIndex: 0,
        },
        telemetry: {
          stepsExecuted: 1,
          toolCalls: 0,
          modelCalls: 0,
          durationMs: 1,
        },
      },
    }),
    close: async () => {},
  });
  const firstServer = await createRunnerServiceServer({
    eventJournal: journal,
    runtimeFactory,
  });

  try {
    const response = await fetch(`${firstServer.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-journal-replay",
        type: "run.start",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
          durability: "continue_on_disconnect",
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-journal-replay",
            runId: "run-journal-replay",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"type":"run\.started"/);
    assert.match(body, /"type":"run\.completed"/);
  } finally {
    await firstServer.close();
  }

  const started = journal.events.find((event) => event.type === "run.started");
  const completed = journal.events.find((event) => event.type === "run.completed");
  assert.ok(started);
  assert.ok(completed);
  assert.ok(journal.events.indexOf(started) < journal.events.indexOf(completed));

  const recreatedServer = await createRunnerServiceServer({
    eventJournal: journal,
    runtimeFactory,
  });
  try {
    const replay = await fetch(`${recreatedServer.url}/events/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        filter: {
          runId: "run-journal-replay",
          sinceEventId: started.id,
        },
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
      }),
    });
    assert.equal(replay.status, 200);
    const replayReader = replay.body?.getReader();
    const replayBody = await readStreamBodyChunk(
      replayReader,
      "timed out waiting for journal replay after host recreation",
    );
    assert.match(replayBody, new RegExp(completed.id));
    assert.doesNotMatch(replayBody, new RegExp(started.id));
    assert.match(replayBody, /"type":"run\.completed"/);
    await replayReader?.cancel();
  } finally {
    await recreatedServer.close();
  }
});

test("runner service emits run.cancelled on the original stream after run.cancel", async () => {
  let resolveAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });

  const server = await createRunnerServiceServer({
    runtimeFactory: () => ({
      runTurn: async (_input, options) => {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            resolveAbort?.();
            resolve();
          }, { once: true });
        });
        throw Object.assign(new Error("cancelled"), { code: "RUN_ABORTED" });
      },
      close: async () => {},
    }),
  });

  try {
    const streamResponse = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-run-cancelled",
        type: "run.start",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-cancelled",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });
    assert.equal(streamResponse.status, 200);

    const cancelResponse = await fetch(`${server.url}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-run-cancel",
        type: "run.cancel",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
        payload: {
          sessionId: "session-cancelled",
        },
      }),
    });
    assert.equal(cancelResponse.status, 200);

    await aborted;
    const body = await streamResponse.text();
    assert.match(body, /"type":"run\.cancelled"/);
    assert.doesNotMatch(body, /"type":"run\.failed"/);
  } finally {
    await server.close();
  }
});
