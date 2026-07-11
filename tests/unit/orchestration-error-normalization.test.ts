import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEvent } from "../../src/kestrel/contracts/events.js";
import type { NormalizedOutput } from "../../src/kestrel/contracts/execution.js";
import type { ThreadRecord } from "../../src/kestrel/contracts/orchestration.js";
import type { SessionRecord } from "../../src/kestrel/contracts/store.js";

import {
  DelegationSupervisor,
  InteractionManager,
  ThreadRuntime,
  type SubmitTurnInput,
  type TurnExecutionInput,
  type TurnExecutionResult,
  type TurnExecutor,
} from "../../src/orchestration/index.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

class StaticTurnExecutor implements TurnExecutor {
  private readonly result: TurnExecutionResult;
  private readonly sessionStore: InMemorySessionStore;

  constructor(sessionStore: InMemorySessionStore, result: TurnExecutionResult) {
    this.sessionStore = sessionStore;
    this.result = result;
  }

  async executeTurn(_input: TurnExecutionInput): Promise<TurnExecutionResult> {
    return this.result;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessionStore.getSession(sessionId);
  }
}

class ThrowingTurnExecutor implements TurnExecutor {
  private readonly sessionStore: InMemorySessionStore;
  private readonly error: Error;

  constructor(sessionStore: InMemorySessionStore, error: Error) {
    this.sessionStore = sessionStore;
    this.error = error;
  }

  async executeTurn(_input: TurnExecutionInput): Promise<TurnExecutionResult> {
    throw this.error;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessionStore.getSession(sessionId);
  }
}

test("InteractionManager emits normalized not-found and state failures", async () => {
  const store = new InMemorySessionStore();
  const manager = new InteractionManager(store);

  await assert.rejects(
    () =>
      manager.resolveRequest({
        threadId: "thread-a",
        requestId: "missing-request",
        message: "reply",
      }),
    { code: "INTERACTION_REQUEST_NOT_FOUND" },
  );

  await store.upsertInteractionRequest({
    requestId: "request-a",
    threadId: "thread-owner",
    kind: "user_input",
    status: "PENDING",
    eventType: "user.reply",
    createdAt: "2026-03-16T12:00:00.000Z",
  });

  await assert.rejects(
    () =>
      manager.resolveRequest({
        threadId: "thread-other",
        requestId: "request-a",
        message: "reply",
      }),
    { code: "INTERACTION_REQUEST_THREAD_MISMATCH" },
  );

  await store.upsertInteractionRequest({
    requestId: "request-b",
    threadId: "thread-owner",
    kind: "user_input",
    status: "RESOLVED",
    eventType: "user.reply",
    createdAt: "2026-03-16T12:00:00.000Z",
    resolvedAt: "2026-03-16T12:00:01.000Z",
  });

  await assert.rejects(
    () =>
      manager.resolveRequest({
        threadId: "thread-owner",
        requestId: "request-b",
        message: "reply",
      }),
    { code: "INTERACTION_REQUEST_NOT_PENDING" },
  );
});

test("ThreadRuntime emits normalized thread and supervisor failures", async () => {
  const store = new InMemorySessionStore();
  const runtime = new ThreadRuntime({
    sessionStore: store,
    executor: new StaticTurnExecutor(store, {
      output: buildOutput({
        runId: "run-a",
        status: "COMPLETED",
      }),
    }),
  });

  await assert.rejects(
    () =>
      runtime.submitTurn({
        threadId: "missing-thread",
        message: "hello",
        eventType: "user.message",
      }),
    { code: "THREAD_NOT_FOUND" },
  );

  await assert.rejects(
    () =>
      runtime.spawnDelegation({
        parentThreadId: "thread-root",
        title: "Research",
        prompt: "Investigate",
      }),
    { code: "DELEGATION_SUPERVISOR_UNAVAILABLE" },
  );
});

test("ThreadRuntime keeps prior active run when failed output run is not persisted", async () => {
  const store = new InMemorySessionStore();
  const runtime = new ThreadRuntime({
    sessionStore: store,
    executor: new StaticTurnExecutor(store, {
      output: buildOutput({
        runId: "run-unpersisted",
        status: "FAILED",
      }),
    }),
  });

  await runtime.startThread({
    threadId: "thread-active-run",
    title: "Thread with active run",
  });

  const persistedRunStartEvent: RuntimeEvent = {
    id: "event-run-persisted",
    type: "user.message",
    sessionId: "thread-active-run",
    payload: {},
  };
  await store.startRun("run-persisted", persistedRunStartEvent);
  await store.completeRun("run-persisted", "COMPLETED");

  const seededThread = await store.getThread("thread-active-run");
  assert.ok(seededThread);
  await store.upsertThread({
    ...seededThread,
    activeRunId: "run-persisted",
    updatedAt: "2026-04-21T00:00:00.000Z",
  });

  const result = await runtime.submitTurn({
    threadId: "thread-active-run",
    message: "trigger failed turn",
    eventType: "user.message",
  });

  assert.equal(result.output.status, "FAILED");
  assert.equal(result.output.runId, "run-unpersisted");
  assert.equal(result.thread.activeRunId, "run-persisted");

  const persistedThread = await store.getThread("thread-active-run");
  assert.equal(persistedThread?.activeRunId, "run-persisted");
});

test("DelegationSupervisor emits normalized limit and compatibility failures", async () => {
  const store = new InMemorySessionStore();
  const supervisor = new DelegationSupervisor({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "session",
      modelProvider: "openrouter",
      model: "model-a",
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 1,
      },
    },
    runtimeStore: store,
    orchestrationStore: store,
    submitChildTurn: async (_input: SubmitTurnInput) => ({
      thread: {
        threadId: "child-thread",
        sessionId: "child-thread",
        title: "Child thread",
        status: "IDLE",
        createdAt: "2026-03-16T12:00:00.000Z",
        updatedAt: "2026-03-16T12:00:00.000Z",
      },
      output: buildOutput({
        runId: "run-child",
        status: "COMPLETED",
      }),
    }),
    startChildThread: async (input) => {
      const thread: ThreadRecord = {
        threadId: "child-thread",
        sessionId: "child-thread",
        title: input.title,
        parentThreadId: input.parentThreadId,
        status: "IDLE",
        createdAt: "2026-03-16T12:00:00.000Z",
        updatedAt: "2026-03-16T12:00:00.000Z",
      };
      await store.ensureSession(thread.sessionId);
      await store.upsertThread(thread);
      return thread;
    },
  });

  await store.upsertDelegation({
    delegationId: "existing",
    parentThreadId: "thread-root",
    childThreadId: "child-existing",
    title: "Existing",
    prompt: "Existing",
    status: "RUNNING",
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:00:00.000Z",
  });

  await assert.rejects(
    () =>
      supervisor.spawnDelegation({
        parentThreadId: "thread-root",
        title: "Overflow",
        prompt: "Overflow",
      }),
    { code: "DELEGATION_LIMIT_REACHED" },
  );

  await assert.rejects(
    () =>
      supervisor.spawnDelegation({
        parentThreadId: "thread-other",
        title: "Profile mismatch",
        prompt: "Mismatch",
        profileId: "other-profile",
      }),
    { code: "DELEGATION_PROFILE_MISMATCH" },
  );

  await assert.rejects(
    () =>
      supervisor.spawnDelegation({
        parentThreadId: "thread-other",
        title: "Provider mismatch",
        prompt: "Mismatch",
        provider: "openai",
      }),
    { code: "DELEGATION_PROVIDER_MISMATCH" },
  );

  await assert.rejects(
    () =>
      supervisor.spawnDelegation({
        parentThreadId: "thread-other",
        title: "Model mismatch",
        prompt: "Mismatch",
        model: "model-b",
      }),
    { code: "DELEGATION_MODEL_MISMATCH" },
  );
});

test("DelegationSupervisor emits normalized not-persisted failure when orchestration store loses the record", async () => {
  const store = new InMemorySessionStore();
  const orchestrationStore = Object.assign(Object.create(store), {
    async getDelegation(_delegationId: string) {
      return null;
    },
  });
  const supervisor = new DelegationSupervisor({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "session",
      modelProvider: "openrouter",
      model: "model-a",
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 2,
      },
    },
    runtimeStore: store,
    orchestrationStore,
    submitChildTurn: async (_input: SubmitTurnInput) => ({
      thread: {
        threadId: "child-thread",
        sessionId: "child-thread",
        title: "Child thread",
        status: "IDLE",
        createdAt: "2026-03-16T12:00:00.000Z",
        updatedAt: "2026-03-16T12:00:00.000Z",
      },
      output: buildOutput({
        runId: "run-child",
        status: "COMPLETED",
      }),
    }),
    startChildThread: async (input) => {
      const thread: ThreadRecord = {
        threadId: "child-thread",
        sessionId: "child-thread",
        title: input.title,
        parentThreadId: input.parentThreadId,
        status: "IDLE",
        createdAt: "2026-03-16T12:00:00.000Z",
        updatedAt: "2026-03-16T12:00:00.000Z",
      };
      await store.ensureSession(thread.sessionId);
      await store.upsertThread(thread);
      return thread;
    },
  });

  await assert.rejects(
    () =>
      supervisor.spawnTask({
        parentSessionId: "thread-root",
        parentRunId: "run-root",
        title: "Research",
        prompt: "Investigate",
      }),
    { code: "DELEGATION_NOT_PERSISTED" },
  );
});

test("Delegation failure persistence retains normalized message and event code", async () => {
  const store = new InMemorySessionStore();
  const runtime = new ThreadRuntime({
    sessionStore: store,
    executor: new ThrowingTurnExecutor(
      store,
      createRuntimeFailure("DELEGATION_CHILD_FAILED", "Child execution failed.", {
        threadId: "child-thread",
      }),
    ),
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "session",
      modelProvider: "openrouter",
      model: "model-a",
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 2,
      },
    },
  });

  await runtime.startThread({
    threadId: "thread-root",
    title: "Root",
  });

  await runtime.spawnDelegation({
    parentThreadId: "thread-root",
    parentRunId: "run-root",
    title: "Research",
    prompt: "Investigate",
  });

  await tick();

  const delegations = await runtime.listDelegations("thread-root");
  assert.equal(delegations[0]?.status, "FAILED");
  assert.equal(delegations[0]?.errorMessage, "Child execution failed.");

  const replay = await store.getReplayStream({
    runId: "run-root",
  });
  const failedEvent = replay.find((event) => event.type === "delegation.failed");
  assert.equal(failedEvent?.metadata?.errorCode, "DELEGATION_CHILD_FAILED");
  assert.equal(failedEvent?.metadata?.errorMessage, "Child execution failed.");
});

function buildOutput(input: {
  runId: string;
  status: NormalizedOutput["status"];
  waitFor?: NormalizedOutput["waitFor"] | undefined;
}): NormalizedOutput {
  return {
    status: input.status,
    sessionId: "session-placeholder",
    runId: input.runId,
    ...(input.waitFor !== undefined ? { waitFor: input.waitFor } : {}),
    quality: {
      citationCoverage: 1,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: 0,
    },
    errors: [],
    telemetry: {
      stepsExecuted: 1,
      toolCalls: 0,
      modelCalls: 0,
      durationMs: 1,
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
