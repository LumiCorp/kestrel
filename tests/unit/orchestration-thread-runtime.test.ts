import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedOutput } from "../../src/kestrel/contracts/execution.js";
import type { PersistedRunRecord, SessionRecord } from "../../src/kestrel/contracts/store.js";

import {
  ThreadRuntime,
  type TurnExecutionInput,
  type TurnExecutionResult,
  type TurnExecutor,
} from "../../src/orchestration/index.js";
import type { TuiProfile } from "../../cli/contracts.js";
import { defaultSupervisionGroupId, fanInCheckpointId } from "../../src/orchestration/Supervision.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import {
  materializeUserFacingWaitInteraction,
  readInteractionPrompt,
} from "../../src/runtime/assistantResponseContract.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

class QueueTurnExecutor implements TurnExecutor {
  readonly inputs: TurnExecutionInput[] = [];
  private readonly queue: TurnExecutionResult[];
  private readonly sessionStore: InMemorySessionStore;

  constructor(sessionStore: InMemorySessionStore, queue: TurnExecutionResult[]) {
    this.sessionStore = sessionStore;
    this.queue = [...queue];
  }

  async executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult> {
    this.inputs.push(structuredClone(input));
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("No queued turn result");
    }
    return materializeFixtureAssistantResponse(next);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessionStore.getSession(sessionId);
  }
}

function materializeFixtureAssistantResponse(
  result: TurnExecutionResult,
): TurnExecutionResult {
  if (result.assistantText !== undefined) {
    return result;
  }
  if (result.output.status === "COMPLETED") {
    return { ...result, assistantText: "Completed test turn." };
  }
  const waitFor = result.output.waitFor;
  if (
    result.output.status === "WAITING" &&
    (waitFor?.kind === "user" || waitFor?.kind === "approval")
  ) {
    const canonicalWaitFor = materializeUserFacingWaitInteraction(waitFor, {
      fallbackRequestId: `request-${result.output.runId}`,
    });
    const prompt = readInteractionPrompt(canonicalWaitFor);
    if (prompt !== undefined) {
      return {
        ...result,
        output: { ...result.output, waitFor: canonicalWaitFor },
        assistantText: prompt,
      };
    }
  }
  return { ...result, assistantText: null };
}

class RunForeignKeyEnforcingStore extends InMemorySessionStore {
  override async appendRunEvent(event: Parameters<InMemorySessionStore["appendRunEvent"]>[0]): Promise<void> {
    const run = await this.getRun(event.runId);
    if (run === null) {
      const error = new Error(`missing run row for ${event.runId}`) as Error & {
        code?: string;
        constraint?: string;
      };
      error.code = "23503";
      error.constraint = "run_events_run_id_fkey";
      throw error;
    }
    await super.appendRunEvent(event);
  }
}

class OperatorRunWindowStore extends InMemorySessionStore {
  readonly listRunInputs: Array<Parameters<InMemorySessionStore["listRuns"]>[0]> = [];
  readonly getRunInputs: string[] = [];
  readonly replayStreamInputs: Array<Parameters<InMemorySessionStore["getReplayStream"]>[0]> = [];
  private readonly operatorRuns: PersistedRunRecord[];

  constructor(runs: PersistedRunRecord[]) {
    super();
    this.operatorRuns = runs.map((run) => structuredClone(run));
  }

  override async getRun(runId: string): Promise<PersistedRunRecord | null> {
    this.getRunInputs.push(runId);
    const run = this.operatorRuns.find((entry) => entry.runId === runId);
    return run === undefined ? null : structuredClone(run);
  }

  override async getReplayStream(
    input: Parameters<InMemorySessionStore["getReplayStream"]>[0],
  ) {
    this.replayStreamInputs.push(structuredClone(input));
    return super.getReplayStream(input);
  }

  override async listRuns(
    input?: Parameters<InMemorySessionStore["listRuns"]>[0],
  ): Promise<PersistedRunRecord[]> {
    this.listRunInputs.push(input === undefined ? undefined : structuredClone(input));
    const runs = this.operatorRuns
      .filter((run) => input?.sessionId === undefined || run.sessionId === input.sessionId)
      .filter((run) => input?.status === undefined || run.status === input.status)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return runs
      .slice(0, input?.limit ?? runs.length)
      .map((run) => structuredClone(run));
  }
}

test("ThreadRuntime binds the canonical main thread to an existing root session thread", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, []);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-web-main",
    sessionId: "session-web-main",
    title: "Imported main thread",
  });

  const mainThread = await runtime.ensureMainThreadForSession({
    sessionId: "session-web-main",
    title: "session-web-main",
  });

  assert.equal(mainThread.threadId, "thread-web-main");
  assert.equal(mainThread.sessionId, "session-web-main");
});

test("ThreadRuntime creates a persisted canonical main thread instead of reusing the session ID", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, []);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  const mainThread = await runtime.ensureMainThreadForSession({
    sessionId: "session-new-main",
    title: "session-new-main",
  });

  assert.equal(mainThread.threadId, "thread-main:session-new-main");
  assert.equal(mainThread.sessionId, "session-new-main");
  assert.notEqual(mainThread.threadId, mainThread.sessionId);
});

test("ThreadRuntime exposes bounded operator run inspection from persisted replay evidence", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, []);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });
  const thread = await runtime.startThread({
    threadId: "thread-run-inspection",
    sessionId: "session-run-inspection",
    title: "Inspect active run",
  });
  await sessionStore.ensureSession(thread.sessionId);
  await sessionStore.upsertThread({
    ...thread,
    status: "RUNNING",
    activeRunId: "run-inspection",
    updatedAt: "2026-07-10T12:00:03.000Z",
  });
  await sessionStore.startRun("run-inspection", {
    id: "event-start",
    type: "user.message",
    sessionId: thread.sessionId,
    payload: {},
  });
  await sessionStore.appendRunEvent({
    runId: "run-inspection",
    sessionId: thread.sessionId,
    type: "run.started",
    level: "INFO",
    timestamp: "2026-07-10T12:00:00.000Z",
    metadata: { threadId: thread.threadId },
  });
  await sessionStore.appendRunEvent({
    runId: "run-inspection",
    sessionId: thread.sessionId,
    type: "reasoning.update",
    level: "INFO",
    timestamp: "2026-07-10T12:00:01.000Z",
    metadata: {
      threadId: thread.threadId,
      message: "Verify the packaged Desktop artifact before cutover.",
    },
  });
  await sessionStore.appendRunEvent({
    runId: "run-inspection",
    sessionId: thread.sessionId,
    type: "wait.entered",
    level: "INFO",
    timestamp: "2026-07-10T12:00:02.000Z",
    metadata: {
      threadId: thread.threadId,
      requestId: "request-package-proof",
      waitFor: { eventType: "operator.approval" },
    },
  });

  const view = await runtime.getOperatorRunView("run-inspection");

  assert.equal(view?.version, "operator-run-v1");
  assert.equal(view?.run.runId, "run-inspection");
  assert.equal(view?.threadId, thread.threadId);
  assert.equal(view?.summary.eventCount, 3);
  assert.equal(view?.summary.truncated, false);
  assert.equal(view?.diagnosis.latestReasoning?.message.includes("packaged Desktop"), true);
  assert.equal(view?.timeline[0]?.label, "run.started");
  assert.equal(view?.timeline[2]?.source, "wait");
  assert.deepEqual(view?.modelProvenance.providers, []);

  const index = await runtime.listOperatorRuns({
    sessionId: thread.sessionId,
    status: "RUNNING",
    limit: 10,
  });
  assert.equal(index.version, "operator-run-index-v1");
  assert.deepEqual(index.filters, {
    sessionId: thread.sessionId,
    status: "RUNNING",
    limit: 10,
  });
  assert.equal(index.hasMore, false);
  assert.equal(index.runs[0]?.run.runId, "run-inspection");
  assert.equal(index.runs[0]?.threadId, thread.threadId);
  assert.equal(index.runs[0]?.summary.eventCount, 3);
  assert.deepEqual(index.sessions[0]?.statusCounts, {
    RUNNING: 1,
    WAITING: 0,
    COMPLETED: 0,
    FAILED: 0,
  });
});

test("ThreadRuntime derives operator session summaries only from the returned run window", async () => {
  const sessionStore = new OperatorRunWindowStore([
    {
      runId: "run-new",
      sessionId: "session-a",
      eventType: "user.message",
      status: "WAITING",
      startedAt: "2026-07-10T12:00:03.000Z",
    },
    {
      runId: "run-mid",
      sessionId: "session-b",
      eventType: "scheduler.tick",
      status: "FAILED",
      startedAt: "2026-07-10T12:00:02.000Z",
      completedAt: "2026-07-10T12:00:02.500Z",
      error: { code: "TEST_FAILURE", message: "fixture failure" },
    },
    {
      runId: "run-excluded",
      sessionId: "session-a",
      eventType: "user.message",
      status: "COMPLETED",
      startedAt: "2026-07-10T12:00:01.000Z",
      completedAt: "2026-07-10T12:00:01.500Z",
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor: new QueueTurnExecutor(sessionStore, []),
    profile: buildProfile(),
  });

  const index = await runtime.listOperatorRuns({ limit: 2 });

  assert.deepEqual(sessionStore.listRunInputs[0], { limit: 3 });
  assert.equal(index.filters.limit, 2);
  assert.equal(index.hasMore, true);
  assert.deepEqual(sessionStore.getRunInputs, []);
  assert.deepEqual(sessionStore.replayStreamInputs, []);
  assert.deepEqual(index.runs.map((entry) => entry.run.runId), ["run-new", "run-mid"]);
  assert.deepEqual(index.sessions, [
    {
      sessionId: "session-a",
      runCount: 1,
      statusCounts: { RUNNING: 0, WAITING: 1, COMPLETED: 0, FAILED: 0 },
      latestRunId: "run-new",
      latestStatus: "WAITING",
      latestStartedAt: "2026-07-10T12:00:03.000Z",
    },
    {
      sessionId: "session-b",
      runCount: 1,
      statusCounts: { RUNNING: 0, WAITING: 0, COMPLETED: 0, FAILED: 1 },
      latestRunId: "run-mid",
      latestStatus: "FAILED",
      latestStartedAt: "2026-07-10T12:00:02.000Z",
    },
  ]);
  assert.deepEqual(Object.keys(index.runs[0]?.run ?? {}).sort(), [
    "eventType",
    "runId",
    "sessionId",
    "startedAt",
    "status",
  ]);
  assert.deepEqual(Object.keys(index.runs[0]?.summary ?? {}).sort(), ["eventCount", "truncated"]);
  const serializedIndex = JSON.stringify(index);
  for (const forbiddenField of [
    "timeline",
    "modelProvenance",
    "runtimePlan",
    "sessionState",
    "events",
    "eventMetadata",
  ]) {
    assert.equal(serializedIndex.includes(`"${forbiddenField}"`), false, forbiddenField);
  }

  const capped = await runtime.listOperatorRuns({ limit: 500 });
  assert.equal(capped.filters.limit, 50);
  assert.deepEqual(sessionStore.listRunInputs[1], { limit: 51 });
});

test("ThreadRuntime preserves pre-start kernel failures whose run row was never created", async () => {
  const sessionStore = new RunForeignKeyEnforcingStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: {
        ...buildOutput({
          runId: "run-pre-start-failure",
          status: "FAILED",
        }),
        errors: [
          {
            code: "SESSION_BUSY",
            message: "Session already has an active run.",
          },
        ],
      },
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-pre-start-failure",
    sessionId: "session-pre-start-failure",
    title: "Pre-start failure",
  });

  const result = await runtime.submitTurn({
    threadId: "thread-pre-start-failure",
    message: "continue",
    eventType: "user.message",
  });

  assert.equal(result.output.status, "FAILED");
  assert.equal(result.output.errors[0]?.code, "SESSION_BUSY");
  const turns = await sessionStore.listConversationTurns({
    threadId: "thread-pre-start-failure",
  });
  const turn = turns[0];
  assert.equal(turn?.status, "FAILED");
  assert.equal(turn?.rootRunId, undefined);
  assert.equal(turn?.activeRunId, undefined);
  assert.equal(turn?.terminalRunId, undefined);
  assert.equal(turn?.terminalStatus, "FAILED");
  assert.equal(turn?.metadata?.outputStatus, "FAILED");
  assert.equal(turn?.metadata?.preStartFailureRunId, "run-pre-start-failure");
  assert.equal(turn?.metadata?.preStartFailureCode, "SESSION_BUSY");
});

test("ThreadRuntime skips side-band reply events when the active run row is stale", async () => {
  const sessionStore = new RunForeignKeyEnforcingStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: {
        ...buildOutput({
          runId: "run-pre-start-reply-failure",
          status: "FAILED",
        }),
        errors: [
          {
            code: "SESSION_BUSY",
            message: "Session already has an active run.",
          },
        ],
      },
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-stale-reply",
    sessionId: "session-stale-reply",
    title: "Stale reply",
  });
  const status = await runtime.getThreadStatus("thread-stale-reply");
  assert.ok(status);
  await sessionStore.upsertThread({
    ...status.thread,
    status: "WAITING",
    activeRunId: "run-stale-missing-row",
    currentRequestId: "request-stale-reply",
  });
  await sessionStore.upsertInteractionRequest({
    requestId: "request-stale-reply",
    threadId: "thread-stale-reply",
    runId: "run-stale-missing-row",
    kind: "user_input",
    eventType: "user.reply",
    status: "PENDING",
    prompt: "continue?",
    createdAt: "2026-07-06T23:49:00.000Z",
    metadata: {},
  });

  const result = await runtime.replyToRequest({
    threadId: "thread-stale-reply",
    requestId: "request-stale-reply",
    message: "continue",
    issuedBy: "operator",
  });

  assert.equal(result.output.status, "FAILED");
  assert.equal(result.output.errors[0]?.code, "SESSION_BUSY");
  const turns = await sessionStore.listConversationTurns({
    threadId: "thread-stale-reply",
  });
  assert.equal(turns[0]?.metadata?.preStartFailureRunId, "run-pre-start-reply-failure");
  assert.equal(turns[0]?.metadata?.preStartFailureCode, "SESSION_BUSY");
});

test("ThreadRuntime surfaces missing run rows for non-pre-start failures", async () => {
  const sessionStore = new RunForeignKeyEnforcingStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-missing-success",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-missing-success",
    sessionId: "session-missing-success",
    title: "Missing success",
  });

  await assert.rejects(
    runtime.submitTurn({
      threadId: "thread-missing-success",
      message: "complete without a run row",
      eventType: "user.message",
    }),
    /missing run row for run-missing-success/u,
  );
});

test("ThreadRuntime fails closed when a session has multiple root threads and no canonical main thread", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, []);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-root-a",
    sessionId: "session-ambiguous",
    title: "Root A",
  });
  await runtime.startThread({
    threadId: "thread-root-b",
    sessionId: "session-ambiguous",
    title: "Root B",
  });

  await assert.rejects(
    () =>
      runtime.ensureMainThreadForSession({
        sessionId: "session-ambiguous",
        title: "session-ambiguous",
      }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string } | undefined)?.code,
        "THREAD_MAIN_RESOLUTION_FAILED",
      );
      return true;
    },
  );
});

test("ThreadRuntime persists operator-facing user input requests from waits", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-wait-1",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            prompt: "Clarify the requirement",
          },
        },
      }),
    },
  ]);

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-parent",
    title: "Parent thread",
  });

  const result = await runtime.submitTurn({
    threadId: "thread-parent",
    message: "start",
    eventType: "user.message",
  });

  assert.equal(result.output.status, "WAITING");
  assert.equal(result.wait?.request?.kind, "user_input");
  assert.equal(result.wait?.request?.prompt, "Clarify the requirement");

  const status = await runtime.getThreadStatus("thread-parent");
  assert.equal(status?.openRequests.length, 1);
  assert.equal(status?.thread.currentRequestId, result.wait?.request?.requestId);
  assert.equal(status?.openRequests[0]?.runId, "run-wait-1");
});

test("ThreadRuntime supersedes stale waits when a new continuation wait replaces them", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-wait-stale-1",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            reason: "planner_mode_blocked",
            blockedActionId: "blocked-action-1",
            prompt: "You're in Plan. Switch to Build: Guarded?",
          },
        },
      }),
    },
    {
      output: buildOutput({
        runId: "run-wait-continuation-2",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            reason: "continuation_handoff",
            blockedActionId: "plan-handoff-2",
            prompt: "Proceed with the approved plan?",
          },
        },
      }),
    },
  ]);

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-supersede-wait",
    title: "Supersede wait thread",
  });

  const first = await runtime.submitTurn({
    threadId: "thread-supersede-wait",
    message: "build the landing page",
    eventType: "user.message",
  });
  const staleRequestId = first.wait?.request?.requestId;
  assert.ok(staleRequestId);

  const second = await runtime.submitTurn({
    threadId: "thread-supersede-wait",
    message: "show me the plan first",
    eventType: "user.message",
  });

  assert.equal(second.output.status, "WAITING");
  assert.equal(second.wait?.request?.prompt, "Proceed with the approved plan?");
  assert.notEqual(second.wait?.request?.requestId, staleRequestId);

  const staleRequest = await sessionStore.getInteractionRequest(staleRequestId);
  assert.equal(staleRequest?.status, "CANCELLED");
  assert.equal(staleRequest?.resolvedAt !== undefined, true);

  const status = await runtime.getThreadStatus("thread-supersede-wait");
  assert.equal(status?.openRequests.length, 1);
  assert.equal(status?.openRequests[0]?.requestId, second.wait?.request?.requestId);
  assert.equal(status?.thread.currentRequestId, second.wait?.request?.requestId);
});

test("ThreadRuntime clears stale waits when a later turn completes without waiting", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-clear-wait-1",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            reason: "planner_mode_blocked",
            blockedActionId: "blocked-action-1",
            prompt: "You're in Plan. Switch to Build: Guarded?",
          },
        },
      }),
    },
    {
      output: buildOutput({
        runId: "run-clear-wait-2",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        message: "Plan recorded.",
      },
    },
  ]);

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-clear-wait",
    title: "Clear wait thread",
  });

  const first = await runtime.submitTurn({
    threadId: "thread-clear-wait",
    message: "build the landing page",
    eventType: "user.message",
  });
  const staleRequestId = first.wait?.request?.requestId;
  assert.ok(staleRequestId);

  const second = await runtime.submitTurn({
    threadId: "thread-clear-wait",
    message: "show me the plan first",
    eventType: "user.message",
  });

  assert.equal(second.output.status, "COMPLETED");
  assert.equal(second.wait, undefined);

  const staleRequest = await sessionStore.getInteractionRequest(staleRequestId);
  assert.equal(staleRequest?.status, "CANCELLED");

  const status = await runtime.getThreadStatus("thread-clear-wait");
  assert.equal(status?.openRequests.length, 0);
  assert.equal(status?.thread.currentRequestId, undefined);
});

test("ThreadRuntime appends completed assistant output to durable thread history", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-history-1",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        message: "Final answer from the runtime.",
      },
      assistantText: "Final answer from the runtime.",
    },
  ]);

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });
  const userLine = {
    role: "user",
    text: "Keep this in history",
    timestamp: "2026-05-11T21:00:00.000Z",
  };

  await runtime.startThread({
    threadId: "thread-history",
    title: "History thread",
    metadata: {
      history: [userLine],
      evidenceLedger: [{ claim: "preserved" }],
    },
  });

  const result = await runtime.submitTurn({
    threadId: "thread-history",
    message: userLine.text,
    eventType: "user.message",
    metadata: {
      history: [
        {
          role: "system",
          text: "Run failed [RUNTIME_ERROR]: old UI-only failure",
          timestamp: "2026-05-11T20:59:00.000Z",
        },
        userLine,
        {
          role: "assistant",
          text: "I am reading the repo.",
          timestamp: "2026-05-11T21:00:01.000Z",
          data: {
            reasoning: true,
          },
        },
      ],
      evidenceLedger: [{ claim: "preserved" }],
    },
  });

  assert.equal(result.output.status, "COMPLETED");

  const executorHistory = executor.inputs[0]?.metadata?.history;
  assert.ok(Array.isArray(executorHistory));
  assert.deepEqual(executorHistory.map((line) => (line as { role?: string }).role), ["user"]);

  const persisted = await sessionStore.getThread("thread-history");
  const history = persisted?.metadata?.history;
  assert.ok(Array.isArray(history));
  assert.deepEqual(history.map((line) => (line as { role?: string }).role), ["user", "assistant"]);
  assert.equal((history[1] as { text?: string }).text, "Final answer from the runtime.");
  assert.deepEqual(persisted?.metadata?.evidenceLedger, [{ claim: "preserved" }]);
});

test("ThreadRuntime preserves submitted history and appends the waiting assistant prompt", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-history-wait-1",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            question: "Need user input",
          },
        },
      }),
    },
  ]);

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });
  const history = [
    {
      role: "system",
      text: "Waiting for 'user.reply'. Question: Need user input",
      timestamp: "2026-05-13T15:43:34.000Z",
    },
    {
      role: "user",
      text: "fix the landing page mounting issue",
      timestamp: "2026-05-13T15:43:35.000Z",
    },
    {
      role: "user",
      text: "try again",
      timestamp: "2026-05-13T15:47:28.000Z",
    },
    {
      role: "assistant",
      text: "I am deciding what to do next.",
      timestamp: "2026-05-13T15:47:29.000Z",
      data: {
        reasoning: true,
      },
    },
  ];

  await runtime.startThread({
    threadId: "thread-history-wait",
    title: "History wait thread",
  });

  const result = await runtime.submitTurn({
    threadId: "thread-history-wait",
    message: "try again",
    eventType: "user.reply",
    metadata: {
      history,
    },
  });

  assert.equal(result.output.status, "WAITING");

  const executorHistory = executor.inputs[0]?.metadata?.history;
  assert.ok(Array.isArray(executorHistory));
  assert.deepEqual(executorHistory.map((line) => (line as { text?: string }).text), [
    "fix the landing page mounting issue",
    "try again",
  ]);

  const persisted = await sessionStore.getThread("thread-history-wait");
  const persistedHistory = persisted?.metadata?.history;
  assert.ok(Array.isArray(persistedHistory));
  assert.deepEqual(persistedHistory.map((line) => (line as { text?: string }).text), [
    "fix the landing page mounting issue",
    "try again",
    "Need user input",
  ]);
  assert.deepEqual(persistedHistory.map((line) => (line as { role?: string }).role), [
    "user",
    "user",
    "assistant",
  ]);
});

test("ThreadRuntime preserves identical waiting prompts from separate runs", async () => {
  const sessionStore = new InMemorySessionStore();
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: {
      question: "Which workspace should I inspect?",
    },
  };
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-repeated-wait-1",
        status: "WAITING",
        waitFor,
      }),
    },
    {
      output: buildOutput({
        runId: "run-repeated-wait-2",
        status: "WAITING",
        waitFor,
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-repeated-wait",
    title: "Repeated wait thread",
  });
  await runtime.submitTurn({
    threadId: "thread-repeated-wait",
    message: "Inspect the first workspace",
    eventType: "user.message",
  });
  await runtime.submitTurn({
    threadId: "thread-repeated-wait",
    message: "Inspect another workspace",
    eventType: "user.message",
  });

  const persisted = await sessionStore.getThread("thread-repeated-wait");
  const history = persisted?.metadata?.history;
  assert.ok(Array.isArray(history));
  assert.deepEqual(history, [
    {
      role: "assistant",
      text: "Which workspace should I inspect?",
      timestamp: history[0]?.timestamp,
      data: { kind: "runtime.assistant_text", runId: "run-repeated-wait-1" },
    },
    {
      role: "assistant",
      text: "Which workspace should I inspect?",
      timestamp: history[1]?.timestamp,
      data: { kind: "runtime.assistant_text", runId: "run-repeated-wait-2" },
    },
  ]);
});

test("ThreadRuntime auto-resolves compact checkpoints after a prior waiting assistant prompt is persisted", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-plan-handoff-1",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            prompt: "Plan ready for build handoff. Would you like me to proceed with the next pass now?",
          },
        },
      }),
    },
    {
      output: buildOutput({
        runId: "run-post-compact-2",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        message: "Started the first implementation pass.",
      },
    },
  ]);

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-plan-handoff-compact",
    title: "Plan handoff compact thread",
    metadata: {
      history: [
        {
          role: "user",
          text: "Build the todo app with sensible defaults.",
          timestamp: "2026-06-03T20:47:39.000Z",
        },
      ],
    },
  });

  const first = await runtime.submitTurn({
    threadId: "thread-plan-handoff-compact",
    message: "Build the todo app with sensible defaults.",
    eventType: "user.message",
  });
  assert.equal(first.output.status, "WAITING");

  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-plan-handoff-compact",
    threadId: "thread-plan-handoff-compact",
    runId: "run-plan-handoff-1",
    status: "PENDING",
    recommendedAction: "compact",
    reason: "Context pressure is high and should compact before the next user reply.",
    createdAt: "2026-06-03T20:48:56.000Z",
  });

  const second = await runtime.submitTurn({
    threadId: "thread-plan-handoff-compact",
    message: "Yes, start building.",
    eventType: "user.reply",
  });

  assert.equal(second.output.status, "COMPLETED");
  assert.equal(executor.inputs.length, 2);

  const checkpoint = await sessionStore.getContextCheckpoint("checkpoint-plan-handoff-compact");
  assert.equal(checkpoint?.status, "ACCEPTED");
  assert.equal(checkpoint?.resolutionAction, "compact");
  assert.equal(checkpoint?.resolvedBy, "runtime.auto");
});

test("ThreadRuntime merges short continuation history with durable thread history", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-history-merge-1",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            prompt: "Need more budget",
          },
        },
      }),
    },
  ]);

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });
  const originalTask = {
    role: "user",
    text: "Build the dashboard export flow",
    timestamp: "2026-05-13T16:00:00.000Z",
  };
  const priorAssistant = {
    role: "assistant",
    text: "I created the export route and still need to verify the download.",
    timestamp: "2026-05-13T16:05:00.000Z",
  };
  const continuationReply = {
    role: "user",
    text: "continue",
    timestamp: "2026-05-13T16:10:00.000Z",
  };

  await runtime.startThread({
    threadId: "thread-history-merge",
    title: "History merge thread",
    metadata: {
      history: [originalTask, priorAssistant],
    },
  });

  const result = await runtime.submitTurn({
    threadId: "thread-history-merge",
    message: continuationReply.text,
    eventType: "user.message",
    metadata: {
      history: [continuationReply],
    },
  });

  assert.equal(result.output.status, "WAITING");

  const executorHistory = executor.inputs[0]?.metadata?.history;
  assert.ok(Array.isArray(executorHistory));
  assert.deepEqual(executorHistory.map((line) => (line as { text?: string }).text), [
    originalTask.text,
    priorAssistant.text,
    continuationReply.text,
  ]);

  const persisted = await sessionStore.getThread("thread-history-merge");
  const persistedHistory = persisted?.metadata?.history;
  assert.ok(Array.isArray(persistedHistory));
  assert.deepEqual(persistedHistory.map((line) => (line as { text?: string }).text), [
    originalTask.text,
    priorAssistant.text,
    continuationReply.text,
    "Need more budget",
  ]);
});

test("ThreadRuntime resolves approval requests and expires turn-scoped grants after resume", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-approval-1",
        status: "WAITING",
        waitFor: {
          kind: "approval",
          eventType: "user.approval",
          metadata: {
            prompt: "Approve file changes",
          },
        },
      }),
    },
    {
      output: buildOutput({
        runId: "run-approval-2",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        ok: true,
      },
    },
  ]);

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-approval",
    title: "Approval thread",
  });

  const waiting = await runtime.submitTurn({
    threadId: "thread-approval",
    message: "change files",
    eventType: "user.message",
  });
  const requestId = waiting.wait?.request?.requestId;
  assert.ok(requestId);

  const resumed = await runtime.replyToRequest({
    threadId: "thread-approval",
    requestId,
    message: "approved",
    interactionMode: "build",
    actSubmode: "full_auto",
    executionPolicy: {
      toolClassPolicy: {
        external_side_effect: true,
      },
    },
    approve: true,
    issuedBy: "operator",
    allowedToolClasses: ["read_only"],
    allowedCapabilities: ["filesystem.read"],
  });

  assert.equal(resumed.output.status, "COMPLETED");
  assert.equal(executor.inputs.length, 2);
  assert.equal(executor.inputs[1]?.resumeBlockedRun, true);
  assert.equal(executor.inputs[1]?.eventType, "user.approval");
  assert.equal(executor.inputs[1]?.interactionMode, "build");
  assert.equal(executor.inputs[1]?.actSubmode, "full_auto");
  assert.deepEqual(executor.inputs[1]?.executionPolicy, {
    toolClassPolicy: {
      external_side_effect: true,
    },
  });

  const grants = await sessionStore.listApprovalGrants({
    threadId: "thread-approval",
  });
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.status, "EXPIRED");

  const requests = await sessionStore.listInteractionRequests({
    threadId: "thread-approval",
  });
  assert.equal(requests[0]?.status, "RESOLVED");
  assert.equal(requests[0]?.runId, "run-approval-1");
  const replay = await sessionStore.getReplayStream({
    threadId: "thread-approval",
  });
  assert.equal(replay.some((event) => event.type === "interaction.requested"), true);
  assert.equal(replay.some((event) => event.type === "interaction.resolved"), true);
  assert.equal(replay.some((event) => event.type === "approval.granted"), true);
});

test("ThreadRuntime resumes the active blocked request and derives approval grants", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-resume-active",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });
  await runtime.startThread({
    threadId: "thread-resume-active",
    title: "Resume active request",
  });
  await sessionStore.upsertInteractionRequest({
    requestId: "request-first",
    threadId: "thread-resume-active",
    runId: "run-waiting",
    kind: "approval",
    eventType: "user.approval",
    status: "PENDING",
    createdAt: "2026-05-22T12:00:00.000Z",
    metadata: {},
  });
  await sessionStore.upsertInteractionRequest({
    requestId: "request-current",
    threadId: "thread-resume-active",
    runId: "run-waiting",
    kind: "approval",
    eventType: "user.approval",
    status: "PENDING",
    createdAt: "2026-05-22T12:01:00.000Z",
    metadata: {},
  });
  await sessionStore.upsertThread({
    ...(await runtime.getThreadStatus("thread-resume-active"))!.thread,
    currentRequestId: "request-current",
    waitFor: {
      kind: "approval",
      eventType: "user.approval",
    },
  });

  const resumed = await runtime.resumeBlockedTurn({
    threadId: "thread-resume-active",
    requestId: "request-current",
    message: "approved",
    interactionMode: "build",
    actSubmode: "full_auto",
    executionPolicy: {
      toolClassPolicy: {
        external_side_effect: true,
      },
      capabilityPolicy: {
        "workspace.write": true,
      },
    },
    actor: {
      actorType: "end_user",
      actorId: "user-1",
      displayName: "User One",
    },
  });

  assert.equal(resumed.output.status, "COMPLETED");
  assert.equal(executor.inputs[0]?.resumeBlockedRun, true);
  assert.equal(executor.inputs[0]?.eventType, "user.approval");
  const grants = await sessionStore.listApprovalGrants({
    threadId: "thread-resume-active",
  });
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.requestId, "request-current");
  assert.equal(grants[0]?.issuedBy, "user-1");
  assert.deepEqual(grants[0]?.allowedToolClasses, [
    "read_only",
    "sandboxed_only",
    "external_side_effect",
  ]);
  assert.deepEqual(grants[0]?.allowedCapabilities, ["workspace.write"]);
});

test("ThreadRuntime spawns delegated child threads with reconstructable lineage", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-child-1",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        summary: "Child completed",
      },
    },
  ]);
  const updates: string[] = [];

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "session",
      modelProvider: "openrouter",
      model: "mock-model",
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 2,
      },
    },
    onTaskUpdate: (update) => {
      updates.push(`${update.kind}:${update.task.taskId}`);
    },
  });

  await runtime.startThread({
    threadId: "thread-root",
    title: "Root",
  });

  const handle = await runtime.spawnDelegation({
    parentThreadId: "thread-root",
    parentRunId: "run-root-1",
    title: "Research issue",
    prompt: "Investigate the failing branch",
    launchedBy: "agent",
  });

  await tick();

  const delegations = await runtime.listDelegations("thread-root");
  assert.equal(delegations.length, 1);
  assert.equal(delegations[0]?.delegationId, handle.delegationId);
  assert.equal(delegations[0]?.childThreadId, handle.childThreadId);
  assert.equal(delegations[0]?.status, "COMPLETED");
  assert.equal(delegations[0]?.childRunId, "run-child-1");

  const child = await runtime.getThreadStatus(handle.childThreadId);
  assert.equal(child?.thread.parentThreadId, "thread-root");
  assert.equal(executor.inputs[0]?.metadata?.delegationId, handle.delegationId);
  assert.equal(executor.inputs[0]?.metadata?.delegationDepth, 1);
  assert.equal(executor.inputs[0]?.metadata?.rootDelegationId, handle.delegationId);

  const replay = await sessionStore.getReplayStream({
    runId: "run-root-1",
  });
  assert.equal(replay.some((event) => event.type === "delegation.requested"), true);
  assert.equal(replay.some((event) => event.type === "delegation.completed"), true);
  assert.equal(updates.some((entry) => entry.startsWith("completed:")), true);
});

test("ThreadRuntime delegation service preserves agent spawn lineage", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-lineage-child",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        summary: "Child completed",
      },
    },
  ]);
  const updates: Array<{
    sourceTaskId?: string | undefined;
    parentTaskId?: string | undefined;
    delegationDepth?: number | undefined;
    rootDelegationId?: string | undefined;
  }> = [];

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
    onTaskUpdate: (update) => {
      updates.push({
        sourceTaskId: update.task.sourceTaskId,
        parentTaskId: update.task.parentTaskId,
        delegationDepth: update.task.delegationDepth,
        rootDelegationId: update.task.rootDelegationId,
      });
    },
  });

  await runtime.startThread({
    threadId: "thread-lineage-root",
    title: "Root",
  });

  const delegationService = runtime.getDelegationService();
  assert.notEqual(delegationService, undefined);
  const snapshot = await delegationService!.spawnTask({
    parentSessionId: "thread-lineage-root",
    parentRunId: "run-lineage-parent",
    title: "Lineage child",
    prompt: "Preserve the active task lineage",
    taskId: "task-active",
    parentTaskId: "task-active",
    delegationDepth: 1,
    rootDelegationId: "delegation-root",
    launchedBy: "agent",
  });

  assert.equal(snapshot.sourceTaskId, "task-active");
  assert.equal(snapshot.parentTaskId, "task-active");
  assert.equal(snapshot.delegationDepth, 2);
  assert.equal(snapshot.rootDelegationId, "delegation-root");

  await tick();

  const delegations = await runtime.listDelegations("thread-lineage-root");
  assert.equal(delegations.length, 1);
  assert.deepEqual(asRecord(delegations[0]?.policy)?.lineage, {
    taskId: "task-active",
    parentTaskId: "task-active",
    delegationDepth: 2,
    rootDelegationId: "delegation-root",
  });

  const result = await delegationService!.getTaskResult(snapshot.taskId);
  assert.equal(result?.task.sourceTaskId, "task-active");
  assert.equal(result?.task.parentTaskId, "task-active");
  assert.equal(result?.task.delegationDepth, 2);
  assert.equal(result?.task.rootDelegationId, "delegation-root");
  assert.deepEqual(updates[0], {
    sourceTaskId: "task-active",
    parentTaskId: "task-active",
    delegationDepth: 2,
    rootDelegationId: "delegation-root",
  });
  assert.deepEqual(
    {
      delegationId: executor.inputs[0]?.metadata?.delegationId,
      activeTaskId: executor.inputs[0]?.metadata?.activeTaskId,
      taskId: executor.inputs[0]?.metadata?.taskId,
      parentTaskId: executor.inputs[0]?.metadata?.parentTaskId,
      delegationDepth: executor.inputs[0]?.metadata?.delegationDepth,
      rootDelegationId: executor.inputs[0]?.metadata?.rootDelegationId,
    },
    {
      delegationId: snapshot.taskId,
      activeTaskId: "task-active",
      taskId: "task-active",
      parentTaskId: "task-active",
      delegationDepth: 2,
      rootDelegationId: "delegation-root",
    },
  );
});

test("ThreadRuntime rejects agent child spawn beyond profile delegation maxDepth", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, []);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: {
      ...buildProfile(),
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 2,
        maxDepth: 1,
      },
    },
  });

  await runtime.startThread({
    threadId: "thread-depth-limit-root",
    title: "Root",
  });

  const delegationService = runtime.getDelegationService();
  assert.notEqual(delegationService, undefined);
  await assert.rejects(
    () =>
      delegationService!.spawnTask({
        parentSessionId: "thread-depth-limit-root",
        parentRunId: "run-depth-limit-parent",
        title: "Too deep",
        prompt: "This child would exceed the configured delegation depth",
        parentTaskId: "task-parent",
        delegationDepth: 1,
        rootDelegationId: "delegation-root",
        launchedBy: "agent",
      }),
    (error: unknown) => {
      const failure = error as {
        code?: string | undefined;
        message?: string | undefined;
        details?: Record<string, unknown> | undefined;
      };
      assert.equal(failure.code, "DELEGATION_DEPTH_LIMIT_REACHED");
      assert.equal(failure.message, "Delegation depth limit reached (2/1).");
      assert.equal(failure.details?.classification, "policy");
      assert.equal(failure.details?.recoverable, true);
      return true;
    },
  );

  assert.equal((await runtime.listDelegations("thread-depth-limit-root")).length, 0);
  assert.equal(executor.inputs.length, 0);
});

test("ThreadRuntime stores completed child result envelope from finalize payload", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-child-result-completed",
        status: "COMPLETED",
      }),
      assistantText: "Child delivered the reviewed implementation.",
      finalizedPayload: {
        status: "completed",
        result: "Child delivered the reviewed implementation.",
        references: ["src/runtime/example.ts", ""],
      },
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-child-result-completed",
    title: "Parent",
  });

  const delegationService = runtime.getDelegationService();
  assert.notEqual(delegationService, undefined);
  const snapshot = await delegationService!.spawnTask({
    parentSessionId: "thread-child-result-completed",
    parentRunId: "run-parent-child-result-completed",
    title: "Complete child result",
    prompt: "Finish the implementation",
    launchedBy: "agent",
  });
  await tick();

  const delegation = await sessionStore.getDelegation(snapshot.taskId);
  assert.deepEqual(delegation?.result, {
    status: "completed",
    result: "Child delivered the reviewed implementation.",
    references: ["src/runtime/example.ts"],
  });
  assert.equal(delegation?.resultSummary, "Child delivered the reviewed implementation.");

  const taskResult = await delegationService!.getTaskResult(snapshot.taskId);
  assert.equal(taskResult?.task.resultSummary, "Child delivered the reviewed implementation.");
  assert.deepEqual(taskResult?.finalizedPayload, {
    status: "completed",
    result: "Child delivered the reviewed implementation.",
    references: ["src/runtime/example.ts", ""],
  });
});

test("ThreadRuntime treats explicit failed child result envelope as failed outcome", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-child-result-explicit-failed",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        status: "failed",
        result: "Child found an unrecoverable contract mismatch.",
        error: {
          code: "CONTRACT_MISMATCH",
          message: "The child found an unrecoverable contract mismatch.",
        },
      },
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-child-result-explicit-failed",
    title: "Parent",
  });

  const delegationService = runtime.getDelegationService();
  assert.notEqual(delegationService, undefined);
  const snapshot = await delegationService!.spawnTask({
    parentSessionId: "thread-child-result-explicit-failed",
    parentRunId: "run-parent-child-result-explicit-failed",
    title: "Explicit failed child result",
    prompt: "Report failure if blocked",
    launchedBy: "agent",
  });
  await tick();

  const delegation = await sessionStore.getDelegation(snapshot.taskId);
  assert.equal(delegation?.status, "FAILED");
  assert.equal(asRecord(delegation?.policy)?.supervision !== undefined, true);
  assert.equal(asRecord(asRecord(delegation?.policy)?.supervision)?.resultState, "failed");
  assert.deepEqual(delegation?.result, {
    status: "failed",
    result: "Child found an unrecoverable contract mismatch.",
    error: {
      code: "CONTRACT_MISMATCH",
      message: "The child found an unrecoverable contract mismatch.",
    },
  });
});

test("ThreadRuntime stores blocked child result envelope when child waits", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-child-result-waiting",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            prompt: "What clarification does the child need?",
          },
        },
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-child-result-waiting",
    title: "Parent",
  });

  const delegationService = runtime.getDelegationService();
  assert.notEqual(delegationService, undefined);
  const snapshot = await delegationService!.spawnTask({
    parentSessionId: "thread-child-result-waiting",
    parentRunId: "run-parent-child-result-waiting",
    title: "Waiting child result",
    prompt: "Ask for clarification if blocked",
    launchedBy: "agent",
  });
  await tick();

  const delegation = await sessionStore.getDelegation(snapshot.taskId);
  assert.deepEqual(delegation?.result, {
    status: "blocked",
    result: "Waiting for user.reply.",
    error: {
      code: "user.reply",
      message: "Child agent is waiting for user.reply.",
    },
  });
  assert.equal(delegation?.resultSummary, "Waiting for user.reply.");
});

test("ThreadRuntime stores failed child result envelope from runtime failure", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, []);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  executor.executeTurn = async () => {
    throw createRuntimeFailure("CHILD_RUNTIME_FAILED", "Child runtime failed deterministically.");
  };

  await runtime.startThread({
    threadId: "thread-child-result-failed",
    title: "Parent",
  });

  const delegationService = runtime.getDelegationService();
  assert.notEqual(delegationService, undefined);
  const snapshot = await delegationService!.spawnTask({
    parentSessionId: "thread-child-result-failed",
    parentRunId: "run-parent-child-result-failed",
    title: "Failed child result",
    prompt: "Fail with runtime error",
    launchedBy: "agent",
  });
  await tick();

  const delegation = await sessionStore.getDelegation(snapshot.taskId);
  assert.deepEqual(delegation?.result, {
    status: "failed",
    result: "Child runtime failed deterministically.",
    error: {
      code: "CHILD_RUNTIME_FAILED",
      message: "Child runtime failed deterministically.",
    },
  });
  assert.equal(delegation?.resultSummary, "Child runtime failed deterministically.");
});

test("ThreadRuntime stores failed child result envelope from returned failed output", async () => {
  const sessionStore = new InMemorySessionStore();
  const output = buildOutput({
    runId: "run-child-result-returned-failed",
    status: "FAILED",
  });
  output.errors = [
    {
      code: "CHILD_MODEL_FAILED",
      message: "Child model failed without throwing.",
    },
  ];
  const executor = new QueueTurnExecutor(sessionStore, [{ output }]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-child-result-returned-failed",
    title: "Parent",
  });

  const delegationService = runtime.getDelegationService();
  assert.notEqual(delegationService, undefined);
  const snapshot = await delegationService!.spawnTask({
    parentSessionId: "thread-child-result-returned-failed",
    parentRunId: "run-parent-child-result-returned-failed",
    title: "Returned failed child result",
    prompt: "Return failed output",
    launchedBy: "agent",
  });
  await tick();

  const delegation = await sessionStore.getDelegation(snapshot.taskId);
  assert.deepEqual(delegation?.result?.error, {
    code: "CHILD_MODEL_FAILED",
    message: "Child model failed without throwing.",
  });
  assert.equal(delegation?.status, "FAILED");
  assert.equal(asRecord(asRecord(delegation?.policy)?.supervision)?.resultState, "failed");
});

test("ThreadRuntime allows child spawn at maxDepth and records normalized depth policy", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-depth-boundary-child",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: {
      ...buildProfile(),
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 2,
        maxDepth: 2,
      },
    },
  });

  await runtime.startThread({
    threadId: "thread-depth-boundary-root",
    title: "Root",
  });

  const delegationService = runtime.getDelegationService();
  assert.notEqual(delegationService, undefined);
  const snapshot = await delegationService!.spawnTask({
    parentSessionId: "thread-depth-boundary-root",
    parentRunId: "run-depth-boundary-parent",
    title: "At boundary",
    prompt: "This child reaches the configured delegation depth",
    taskId: "task-active",
    parentTaskId: "task-parent",
    delegationDepth: 1,
    rootDelegationId: "delegation-root",
    launchedBy: "agent",
  });

  assert.equal(snapshot.delegationDepth, 2);
  assert.equal(snapshot.rootDelegationId, "delegation-root");

  await tick();

  const delegations = await runtime.listDelegations("thread-depth-boundary-root");
  assert.equal(delegations.length, 1);
  assert.deepEqual(
    {
      depth: asRecord(delegations[0]?.policy)?.depth,
      maxDepth: asRecord(delegations[0]?.policy)?.maxDepth,
      rootDelegationId: asRecord(delegations[0]?.policy)?.rootDelegationId,
      parentTaskId: asRecord(delegations[0]?.policy)?.parentTaskId,
      sourceMutationFanIn: asRecord(delegations[0]?.policy)?.sourceMutationFanIn,
    },
    {
      depth: 2,
      maxDepth: 2,
      rootDelegationId: "delegation-root",
      parentTaskId: "task-parent",
      sourceMutationFanIn: "manual",
    },
  );
  assert.deepEqual(asRecord(delegations[0]?.policy)?.lineage, {
    taskId: "task-active",
    parentTaskId: "task-parent",
    delegationDepth: 2,
    rootDelegationId: "delegation-root",
  });
  assert.equal(executor.inputs[0]?.metadata?.delegationDepth, 2);
  assert.equal(executor.inputs[0]?.metadata?.rootDelegationId, "delegation-root");
});

test("ThreadRuntime child spawn preserves managed worktree fan-in context", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-managed-worktree-fanin-child",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-managed-worktree-fanin-root",
    title: "Root",
  });

  const delegationService = runtime.getDelegationService();
  assert.notEqual(delegationService, undefined);
  const snapshot = await delegationService!.spawnTask({
    parentSessionId: "thread-managed-worktree-fanin-root",
    parentRunId: "run-managed-worktree-fanin-parent",
    title: "Managed worktree child",
    prompt: "Keep source mutations behind managed fan-in.",
    taskId: "task-active",
    parentTaskId: "task-parent",
    delegationDepth: 0,
    rootDelegationId: "delegation-root",
    launchedBy: "agent",
  });

  assert.equal(snapshot.parentTaskId, "task-parent");
  assert.equal(snapshot.delegationDepth, 1);

  await tick();

  const delegations = await runtime.listDelegations("thread-managed-worktree-fanin-root");
  assert.equal(delegations.length, 1);
  const policy = asRecord(delegations[0]?.policy);
  assert.equal(policy?.parentTaskId, "task-parent");
  assert.equal(policy?.sourceMutationFanIn, "manual");
  assert.deepEqual(policy?.lineage, {
    taskId: "task-active",
    parentTaskId: "task-parent",
    delegationDepth: 1,
    rootDelegationId: "delegation-root",
  });
  assert.equal(executor.inputs[0]?.metadata?.parentTaskId, "task-parent");
});

test("ThreadRuntime operator child spawn preserves policy supervision intent", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-operator-supervision-child",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-operator-supervision-root",
    title: "Root",
  });

  await runtime.spawnChildThread({
    threadId: "thread-operator-supervision-root",
    prompt: "Inspect the runtime policy",
    policy: {
      sourceCheckpointId: "checkpoint-existing",
      sourceMutationFanIn: "manual",
      supervision: {
        groupId: "group-existing",
        rolePrompt: "Review implementation",
        goal: "Find runtime regressions",
        budget: {
          maxTurns: 2,
          allowApprovalInheritance: false,
        },
        reconciliationIntent: "manual_review",
        resultState: "blocked",
        outcomeReason: "Waiting on stale context",
        latestFanInDisposition: "deferred",
        latestFanInCheckpointId: "checkpoint-stale",
      },
    },
  });
  await tick();

  const delegations = await runtime.listDelegations("thread-operator-supervision-root");
  assert.equal(delegations.length, 1);
  assert.deepEqual(asRecord(delegations[0]?.policy)?.supervision, {
    groupId: "group-existing",
    rolePrompt: "Review implementation",
    goal: "Find runtime regressions",
    budget: {
      maxTurns: 2,
      allowApprovalInheritance: false,
    },
    reconciliationIntent: "manual_review",
    resultState: "completed",
  });
  assert.equal(asRecord(delegations[0]?.policy)?.sourceCheckpointId, "checkpoint-existing");
  assert.equal(asRecord(delegations[0]?.policy)?.sourceMutationFanIn, "manual");
});

test("ThreadRuntime records replay-aware compaction artifacts when compaction is applied", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-compact-1",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        message: "Compacted result",
        decisions: ["Keep recent history until the prompt budget requires clipping."],
        artifactsFiles: ["agents/reference-react/src/context/ContextRequestBuilder.ts"],
      },
    },
    {
      output: buildOutput({
        runId: "run-compact-2",
        status: "COMPLETED",
      }),
    },
  ]);

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-compact",
    title: "Compaction thread",
  });
  const seededSession = await sessionStore.getSession("thread-compact");
  assert.ok(seededSession);
  await sessionStore.patchSessionState({
    sessionId: "thread-compact",
    expectedVersion: seededSession.version,
    reason: "seed_next_action",
    statePatch: {
      agent: {
        ...((seededSession.state.agent ?? {}) as Record<string, unknown>),
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
      },
    },
  });
  const beforeVersions = sessionStore.getSessionVersionRecordsForTest("thread-compact");
  const beforeState = await sessionStore.getSession("thread-compact");

  const result = await runtime.submitTurn({
    threadId: "thread-compact",
    message: "summarize",
    eventType: "user.message",
    manualCompaction: true,
  });

  assert.equal(result.compactionAction, "compact");
  const afterVersions = sessionStore.getSessionVersionRecordsForTest("thread-compact");
  const afterState = await sessionStore.getSession("thread-compact");
  assert.equal(afterVersions.length, beforeVersions.length);
  assert.equal(afterState?.version, beforeState?.version);
  assert.deepEqual(
    ((afterState?.state.agent as Record<string, unknown> | undefined)?.nextAction),
    ((beforeState?.state.agent as Record<string, unknown> | undefined)?.nextAction),
  );

  const status = await runtime.getThreadStatus("thread-compact");
  assert.equal(status?.latestSummary?.summary.includes("Run run-compact-1 finished with status COMPLETED."), true);
  assert.equal(
    (status?.latestSummary?.metadata?.structuredSummary as { version?: string } | undefined)?.version,
    "v1",
  );
  assert.deepEqual(
    (status?.latestSummary?.metadata?.structuredSummary as { sourceRunIds?: string[] } | undefined)?.sourceRunIds,
    ["run-compact-1"],
  );

  const events = await sessionStore.listThreadCompactionEvents("thread-compact");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, "compact");
  assert.equal(events[0]?.runId, "run-compact-1");
  assert.equal(events[0]?.summaryArtifactId, status?.latestSummary?.artifactId);
  const replay = await sessionStore.getReplayStream({
    threadId: "thread-compact",
  });
  assert.equal(replay.some((event) => event.type === "context.compaction_applied"), true);

  await runtime.submitTurn({
    threadId: "thread-compact",
    message: "continue",
    eventType: "user.message",
  });
  const secondInput = executor.inputs[1];
  assert.equal(
    (secondInput?.metadata?.authoritativeContextSummary as { artifactId?: string } | undefined)?.artifactId,
    status?.latestSummary?.artifactId,
  );
});

test("ThreadRuntime auto-resolves pending compact checkpoints on submit and continues execution", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-auto-compact-1",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-auto-compact",
    title: "Auto compact thread",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-auto-compact",
    threadId: "thread-auto-compact",
    runId: "run-auto-compact-0",
    status: "PENDING",
    recommendedAction: "compact",
    reason: "Thread is thrashing and should compact before more work continues.",
    createdAt: new Date().toISOString(),
  });

  const result = await runtime.submitTurn({
    threadId: "thread-auto-compact",
    message: "continue work",
    eventType: "user.message",
    metadata: {
      history: [
        {
          role: "user",
          text: "Implement the Kestrel Desktop context-preservation fix.",
          timestamp: "2026-05-18T12:00:00.000Z",
        },
        {
          role: "assistant",
          text: "Raised the history window and found the pending checkpoint submit path.",
          timestamp: "2026-05-18T12:01:00.000Z",
        },
        {
          role: "user",
          text: "continue work",
          timestamp: "2026-05-18T12:02:00.000Z",
        },
      ],
    },
  });

  assert.equal(result.output.status, "COMPLETED");
  assert.equal(executor.inputs.length, 1);
  const status = await runtime.getThreadStatus("thread-auto-compact");
  const summary = status?.latestSummary;
  assert.ok(summary);
  assert.equal(summary.source, "policy_checkpoint");
  assert.match(summary.summary, /Treat this as a continuation handoff, not a new task/u);
  assert.match(summary.summary, /Use the preserved transcript, current runtime state, tool results, and files as the source of truth/u);
  assert.match(summary.summary, /Original task: Implement the Kestrel Desktop context-preservation fix/u);
  assert.match(summary.summary, /The latest assistant-visible state before this checkpoint was: "Raised the history window/u);
  assert.match(summary.summary, /Next behavior: continue from the latest concrete state/u);
  assert.doesNotMatch(summary.summary, /structuredSummary/u);
  assert.equal(
    (executor.inputs[0]?.metadata?.authoritativeContextSummary as { artifactId?: string } | undefined)?.artifactId,
    summary.artifactId,
  );
  const checkpoint = await sessionStore.getContextCheckpoint("checkpoint-auto-compact");
  assert.equal(checkpoint?.status, "ACCEPTED");
  assert.equal(checkpoint?.resolutionAction, "compact");
  assert.equal(checkpoint?.resolvedBy, "runtime.auto");

  const replay = await sessionStore.getReplayStream({
    threadId: "thread-auto-compact",
  });
  const autoResolved = replay.find((event) => event.type === "context.checkpoint_auto_resolved");
  assert.equal(autoResolved?.metadata?.checkpointId, "checkpoint-auto-compact");
  assert.equal(autoResolved?.metadata?.recommendedAction, "compact");
});

test("ThreadRuntime blocks auto compact when a continuation brief cannot be grounded", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-ungrounded-compact",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-ungrounded-compact",
    title: "Ungrounded compact thread",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-ungrounded-compact",
    threadId: "thread-ungrounded-compact",
    runId: "run-ungrounded-compact-0",
    status: "PENDING",
    recommendedAction: "compact",
    reason: "Thread context pressure is high and needs an operator checkpoint.",
    createdAt: new Date().toISOString(),
  });

  await assert.rejects(
    () =>
      runtime.submitTurn({
        threadId: "thread-ungrounded-compact",
        message: "continue",
        eventType: "user.message",
      }),
    (error: unknown) => {
      const runtimeError = error as {
        code?: string;
        details?: Record<string, unknown>;
      };
      assert.equal(runtimeError.code, "CONTEXT_CHECKPOINT_PENDING");
      assert.equal(runtimeError.details?.checkpointId, "checkpoint-ungrounded-compact");
      assert.equal(runtimeError.details?.recommendedAction, "compact");
      assert.match(
        String(runtimeError.details?.reason),
        /Continuation brief unavailable/u,
      );
      return true;
    },
  );

  const checkpoint = await sessionStore.getContextCheckpoint("checkpoint-ungrounded-compact");
  assert.equal(checkpoint?.status, "PENDING");
  assert.equal(executor.inputs.length, 0);
});

test("ThreadRuntime auto-resolves pending summarize_forward checkpoints on submit and continues execution", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-auto-summarize-1",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-auto-summarize",
    title: "Auto summarize thread",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-auto-summarize",
    threadId: "thread-auto-summarize",
    runId: "run-auto-summarize-0",
    status: "PENDING",
    recommendedAction: "summarize_forward",
    reason: "Evidence recovery is exhausted.",
    createdAt: new Date().toISOString(),
  });

  const result = await runtime.submitTurn({
    threadId: "thread-auto-summarize",
    message: "continue work",
    eventType: "user.message",
  });

  assert.equal(result.output.status, "COMPLETED");
  assert.equal(executor.inputs.length, 1);
  const checkpoint = await sessionStore.getContextCheckpoint("checkpoint-auto-summarize");
  assert.equal(checkpoint?.status, "ACCEPTED");
  assert.equal(checkpoint?.resolutionAction, "summarize_forward");
  assert.equal(checkpoint?.resolvedBy, "runtime.auto");

  const replay = await sessionStore.getReplayStream({
    threadId: "thread-auto-summarize",
  });
  const autoResolved = replay.find((event) => event.type === "context.checkpoint_auto_resolved");
  assert.equal(autoResolved?.metadata?.checkpointId, "checkpoint-auto-summarize");
  assert.equal(autoResolved?.metadata?.recommendedAction, "summarize_forward");
});

test("ThreadRuntime blocks submit when a non-auto context checkpoint is pending", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-blocked-should-not-run",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-checkpoint-blocked",
    title: "Blocked checkpoint thread",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-blocked",
    threadId: "thread-checkpoint-blocked",
    runId: "run-blocked-0",
    status: "PENDING",
    recommendedAction: "handoff",
    reason: "Context pressure is high and requires handoff.",
    createdAt: new Date().toISOString(),
  });

  await assert.rejects(
    () =>
      runtime.submitTurn({
        threadId: "thread-checkpoint-blocked",
        message: "continue work",
        eventType: "user.message",
      }),
    (error: unknown) => {
      const runtimeError = error as {
        code?: string;
        details?: Record<string, unknown>;
      };
      assert.equal(runtimeError.code, "CONTEXT_CHECKPOINT_PENDING");
      assert.equal(runtimeError.details?.checkpointId, "checkpoint-blocked");
      assert.equal(runtimeError.details?.recommendedAction, "handoff");
      return true;
    },
  );
  assert.equal(executor.inputs.length, 0);
});

test("ThreadRuntime resolves auto checkpoints before blocking on a pending manual checkpoint", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-blocked-after-auto",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-checkpoint-mixed",
    title: "Mixed checkpoint thread",
    metadata: {
      history: [
        {
          role: "user",
          text: "Continue the mixed checkpoint runtime flow.",
          timestamp: "2026-04-20T11:59:58.000Z",
        },
        {
          role: "assistant",
          text: "Prepared to resolve compact context before hitting the manual handoff.",
          timestamp: "2026-04-20T11:59:59.000Z",
        },
      ],
    },
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-manual-newer",
    threadId: "thread-checkpoint-mixed",
    runId: "run-checkpoint-mixed-1",
    status: "PENDING",
    recommendedAction: "handoff",
    reason: "Manual checkpoint must be acknowledged.",
    createdAt: "2026-04-20T12:00:01.000Z",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-auto-older",
    threadId: "thread-checkpoint-mixed",
    runId: "run-checkpoint-mixed-0",
    status: "PENDING",
    recommendedAction: "compact",
    reason: "Thread is thrashing and should compact before more work continues.",
    createdAt: "2026-04-20T12:00:00.000Z",
  });

  await assert.rejects(
    () =>
      runtime.submitTurn({
        threadId: "thread-checkpoint-mixed",
        message: "continue work",
        eventType: "user.message",
      }),
    (error: unknown) => {
      const runtimeError = error as {
        code?: string;
        details?: Record<string, unknown>;
      };
      assert.equal(runtimeError.code, "CONTEXT_CHECKPOINT_PENDING");
      assert.equal(runtimeError.details?.checkpointId, "checkpoint-manual-newer");
      assert.equal(runtimeError.details?.recommendedAction, "handoff");
      return true;
    },
  );

  const autoCheckpoint = await sessionStore.getContextCheckpoint("checkpoint-auto-older");
  assert.equal(autoCheckpoint?.status, "ACCEPTED");
  assert.equal(autoCheckpoint?.resolutionAction, "compact");
  assert.equal(autoCheckpoint?.resolvedBy, "runtime.auto");
  assert.equal(executor.inputs.length, 0);
});

test("ThreadRuntime submit checkpoint gate ignores pending fan-in checkpoints", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-fanin-ignored-1",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-fanin-ignored",
    title: "Fan-in ignored",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-fanin-ignored",
    threadId: "thread-fanin-ignored",
    runId: "run-fanin-ignored-0",
    status: "PENDING",
    recommendedAction: "operator_checkpoint",
    reason: "Review fan-in selection before proceeding.",
    metadata: {
      kind: "fan_in",
    },
    createdAt: new Date().toISOString(),
  });

  const result = await runtime.submitTurn({
    threadId: "thread-fanin-ignored",
    message: "continue work",
    eventType: "user.message",
  });
  assert.equal(result.output.status, "COMPLETED");
  assert.equal(executor.inputs.length, 1);
  const checkpoint = await sessionStore.getContextCheckpoint("checkpoint-fanin-ignored");
  assert.equal(checkpoint?.status, "PENDING");
});

test("ThreadRuntime surfaces operator inbox items for pending requests and context checkpoints", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-inbox-1",
        status: "WAITING",
        waitFor: {
          kind: "approval",
          eventType: "user.approval",
          metadata: {
            prompt: "Approve this action",
          },
        },
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-inbox",
    title: "Inbox thread",
  });
  await runtime.submitTurn({
    threadId: "thread-inbox",
    message: "needs approval",
    eventType: "user.message",
  });

  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-inbox-1",
    threadId: "thread-inbox",
    runId: "run-inbox-1",
    status: "PENDING",
    recommendedAction: "compact",
    reason: "Context pressure near threshold",
    createdAt: new Date().toISOString(),
  });

  const inbox = await runtime.listOperatorInbox({ threadId: "thread-inbox" });
  assert.equal(inbox.summary.approvals, 1);
  assert.equal(inbox.summary.checkpoints, 1);
  assert.equal(inbox.items.some((item) => item.kind === "approval_request"), true);
  assert.equal(inbox.items.some((item) => item.kind === "context_checkpoint"), true);
});

test("ThreadRuntime steerThread persists operator steering events", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-steer-1",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-steer",
    title: "Steer thread",
  });
  const result = await runtime.steerThread({
    threadId: "thread-steer",
    message: "Focus on the child blocker first.",
    issuedBy: "operator",
  });

  assert.equal(result.status, "applied");
  assert.equal(result.result?.output.status, "COMPLETED");
  assert.equal(executor.inputs[0]?.eventType, "operator.steer");
  assert.equal(executor.inputs[0]?.metadata?.steering, true);

  const replay = await sessionStore.getReplayStream({
    runId: "run-steer-1",
  });
  const steeringEvent = replay.find((event) => event.type === "operator.steered");
  assert.equal(steeringEvent?.metadata?.threadId, "thread-steer");
  assert.equal(steeringEvent?.metadata?.message, "Focus on the child blocker first.");
});

test("ThreadRuntime steerThread starts a fresh steering turn when user input is pending", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-steer-wait-1",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            reason: "loop_visit_stall",
            prompt: "Reply continue to resume.",
            resumeReply: "continue",
          },
        },
      }),
    },
    {
      output: buildOutput({
        runId: "run-steer-fresh-1",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-steer-pending-wait",
    title: "Steer pending wait thread",
  });
  const waiting = await runtime.submitTurn({
    threadId: "thread-steer-pending-wait",
    message: "start",
    eventType: "user.message",
  });
  assert.equal(waiting.output.status, "WAITING");
  assert.equal(waiting.wait?.request?.kind, "user_input");

  const result = await runtime.steerThread({
    threadId: "thread-steer-pending-wait",
    message: "Stop copy edits and inspect the rendered app.",
    issuedBy: "operator",
  });

  assert.equal(result.status, "applied");
  assert.equal(executor.inputs[1]?.eventType, "operator.steer");
  assert.equal(executor.inputs[1]?.message, "Stop copy edits and inspect the rendered app.");
  assert.equal(executor.inputs[1]?.metadata?.steering, true);
});

test("ThreadRuntime queues steering during a running turn and drains it after the boundary", async () => {
  const sessionStore = new InMemorySessionStore();
  let releaseMainTurn: (() => void) | undefined;
  const executor = new class extends QueueTurnExecutor {
    override async executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult> {
      this.inputs.push(structuredClone(input));
      if (input.eventType === "user.message") {
        await new Promise<void>((resolve) => {
          releaseMainTurn = resolve;
        });
        return {
          output: buildOutput({
            runId: "run-main-1",
            status: "COMPLETED",
          }),
          assistantText: "Main turn completed.",
        };
      }
      return {
        output: buildOutput({
          runId: "run-steer-2",
          status: "COMPLETED",
        }),
        assistantText: "Steering applied.",
      };
    }
  }(sessionStore, []);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-steer-queued",
    title: "Queued steer thread",
  });

  const mainTurn = runtime.submitTurn({
    threadId: "thread-steer-queued",
    message: "start",
    eventType: "user.message",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queued = await runtime.steerThread({
    threadId: "thread-steer-queued",
    message: "Pause after the current step and regroup.",
    issuedBy: "operator",
  });
  releaseMainTurn?.();
  const mainResult = await mainTurn;

  assert.equal(queued.status, "queued");
  assert.equal(queued.pendingSteer?.message, "Pause after the current step and regroup.");
  assert.equal(mainResult.output.runId, "run-main-1");

  for (let attempt = 0; attempt < 10 && executor.inputs.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(executor.inputs[0]?.eventType, "user.message");
  assert.equal(executor.inputs[1]?.eventType, "operator.steer");
  assert.equal(executor.inputs[1]?.message, "Pause after the current step and regroup.");

  const replay = await sessionStore.getReplayStream({
    runId: "run-steer-2",
  });
  const steeringEvent = replay.find((event) => event.type === "operator.steered");
  assert.equal(steeringEvent?.metadata?.threadId, "thread-steer-queued");
  assert.equal(steeringEvent?.metadata?.message, "Pause after the current step and regroup.");
});

test("ThreadRuntime drains queued steering as operator steer when the interrupted run ends waiting", async () => {
  const sessionStore = new InMemorySessionStore();
  let releaseMainTurn: (() => void) | undefined;
  const executor = new class extends QueueTurnExecutor {
    override async executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult> {
      this.inputs.push(structuredClone(input));
      if (input.eventType === "user.message") {
        await new Promise<void>((resolve) => {
          releaseMainTurn = resolve;
        });
        return {
          output: buildOutput({
            runId: "run-main-wait-1",
            status: "WAITING",
            waitFor: {
              kind: "user",
              eventType: "user.reply",
              metadata: {
                reason: "loop_visit_stall",
                prompt: "Reply continue to resume.",
                resumeReply: "continue",
              },
            },
          }),
          assistantText: "Reply continue to resume.",
        };
      }
      return {
        output: buildOutput({
          runId: "run-steer-after-wait-1",
          status: "COMPLETED",
        }),
        assistantText: "Steering applied after wait.",
      };
    }
  }(sessionStore, []);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-steer-queued-wait",
    title: "Queued steer wait thread",
  });

  const mainTurn = runtime.submitTurn({
    threadId: "thread-steer-queued-wait",
    message: "start",
    eventType: "user.message",
  });
  await tick();
  const queued = await runtime.steerThread({
    threadId: "thread-steer-queued-wait",
    message: "Stop stale work and re-plan.",
    issuedBy: "operator",
  });
  releaseMainTurn?.();
  const mainResult = await mainTurn;

  assert.equal(queued.status, "queued");
  assert.equal(mainResult.output.status, "WAITING");

  for (let attempt = 0; attempt < 10 && executor.inputs.length < 2; attempt += 1) {
    await tick();
  }

  assert.equal(executor.inputs[0]?.eventType, "user.message");
  assert.equal(executor.inputs[1]?.eventType, "operator.steer");
  assert.equal(executor.inputs[1]?.message, "Stop stale work and re-plan.");
});

test("ThreadRuntime retryThread allows retry for failed threads and blocks idle threads", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-retry-failed-1",
        status: "FAILED",
      }),
    },
    {
      output: buildOutput({
        runId: "run-retry-success-2",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-retry",
    title: "Retry thread",
  });
  const failed = await runtime.submitTurn({
    threadId: "thread-retry",
    message: "run and fail",
    eventType: "user.message",
  });
  assert.equal(failed.output.status, "FAILED");

  const retried = await runtime.retryThread({
    threadId: "thread-retry",
    reason: "retry after operator review",
  });
  assert.equal(retried.output.status, "COMPLETED");
  assert.equal(executor.inputs[1]?.eventType, "operator.retry");

  await runtime.startThread({
    threadId: "thread-idle",
    title: "Idle thread",
  });
  await assert.rejects(
    () =>
      runtime.retryThread({
        threadId: "thread-idle",
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "OPERATOR_THREAD_NOT_RETRYABLE");
      return true;
    },
  );
});

test("ThreadRuntime resolves context checkpoints and persists compaction lineage", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-checkpoint-1",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-checkpoint",
    title: "Checkpoint thread",
  });
  await runtime.submitTurn({
    threadId: "thread-checkpoint",
    message: "baseline turn",
    eventType: "user.message",
  });
  const beforeVersions = sessionStore.getSessionVersionRecordsForTest("thread-checkpoint");
  const beforeState = await sessionStore.getSession("thread-checkpoint");
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-1",
    threadId: "thread-checkpoint",
    runId: "run-checkpoint-1",
    status: "PENDING",
    recommendedAction: "compact",
    reason: "High context pressure",
    signals: {
      contextBudgetRatio: 0.92,
      lowProgressTurns: 2,
    },
    createdAt: new Date().toISOString(),
  });

  const status = await runtime.resolveContextCheckpoint({
    threadId: "thread-checkpoint",
    checkpointId: "checkpoint-1",
    action: "compact",
    issuedBy: "operator",
  });

  const afterVersions = sessionStore.getSessionVersionRecordsForTest("thread-checkpoint");
  const afterState = await sessionStore.getSession("thread-checkpoint");
  assert.equal(afterVersions.length, beforeVersions.length);
  assert.equal(afterState?.version, beforeState?.version);

  const checkpoint = status.contextCheckpoints.find((entry) => entry.checkpointId === "checkpoint-1");
  assert.equal(checkpoint?.status, "ACCEPTED");
  assert.equal(checkpoint?.resolutionAction, "compact");

  const artifacts = await sessionStore.listContextSummaryArtifacts("thread-checkpoint");
  assert.equal(artifacts.length >= 1, true);
  assert.equal(artifacts[0]?.source, "policy_checkpoint");

  const events = await sessionStore.listThreadCompactionEvents("thread-checkpoint");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, "compact");
  assert.equal(events[0]?.reason, "High context pressure");
  assert.equal(events[0]?.runId, "run-checkpoint-1");
  assert.equal(typeof events[0]?.summaryArtifactId, "string");
});

test("ThreadRuntime resolves summarize_forward checkpoints with persisted adaptation lineage", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-checkpoint-summarize-forward",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-checkpoint-summarize-forward",
    title: "Checkpoint summarize forward",
  });
  await runtime.submitTurn({
    threadId: "thread-checkpoint-summarize-forward",
    message: "baseline turn",
    eventType: "user.message",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-summarize-forward",
    threadId: "thread-checkpoint-summarize-forward",
    runId: "run-checkpoint-summarize-forward",
    status: "PENDING",
    recommendedAction: "summarize_forward",
    reason: "Evidence recovery is exhausted.",
    createdAt: new Date().toISOString(),
  });

  const status = await runtime.resolveContextCheckpoint({
    threadId: "thread-checkpoint-summarize-forward",
    checkpointId: "checkpoint-summarize-forward",
    action: "summarize_forward",
    issuedBy: "operator",
  });

  const checkpoint = status.contextCheckpoints.find(
    (entry) => entry.checkpointId === "checkpoint-summarize-forward",
  );
  assert.equal(checkpoint?.status, "ACCEPTED");
  assert.equal(checkpoint?.resolutionAction, "summarize_forward");

  const artifacts = await sessionStore.listContextSummaryArtifacts("thread-checkpoint-summarize-forward");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.source, "summarize_forward");
  assert.equal(artifacts[0]?.metadata?.action, "summarize_forward");

  const compaction = await sessionStore.listThreadCompactionEvents("thread-checkpoint-summarize-forward");
  assert.equal(compaction.length, 1);
  assert.equal(compaction[0]?.action, "summarize_forward");
  assert.equal(compaction[0]?.reason, "Evidence recovery is exhausted.");

  const replay = await sessionStore.getReplayStream({
    runId: "run-checkpoint-summarize-forward",
  });
  const adaptationEvent = replay.find((event) => event.type === "context.adaptation_applied");
  assert.equal(adaptationEvent?.metadata?.action, "summarize_forward");
  assert.equal(adaptationEvent?.metadata?.checkpointId, "checkpoint-summarize-forward");
  assert.equal(
    typeof adaptationEvent?.metadata?.summaryArtifactId === "string",
    true,
  );
});

test("ThreadRuntime resolves split_into_child_thread checkpoints with child lineage references", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-checkpoint-split-parent",
        status: "COMPLETED",
      }),
    },
    {
      output: buildOutput({
        runId: "run-checkpoint-split-child",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        summary: "Child resolved split objective",
      },
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text", "web.search"],
    }),
  });

  await runtime.startThread({
    threadId: "thread-checkpoint-split-parent",
    title: "Checkpoint split parent",
  });
  await runtime.submitTurn({
    threadId: "thread-checkpoint-split-parent",
    message: "baseline turn",
    eventType: "user.message",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-split",
    threadId: "thread-checkpoint-split-parent",
    runId: "run-checkpoint-split-parent",
    status: "PENDING",
    recommendedAction: "split_into_child_thread",
    reason: "Split the remaining objective.",
    metadata: {
      splitPrompt: "Continue unresolved objective in a child thread.",
      splitTitle: "Child split objective",
    },
    createdAt: new Date().toISOString(),
  });

  const status = await runtime.resolveContextCheckpoint({
    threadId: "thread-checkpoint-split-parent",
    checkpointId: "checkpoint-split",
    action: "split_into_child_thread",
    issuedBy: "operator",
  });
  await tick();

  const checkpoint = status.contextCheckpoints.find((entry) => entry.checkpointId === "checkpoint-split");
  assert.equal(checkpoint?.status, "ACCEPTED");
  assert.equal(checkpoint?.resolutionAction, "split_into_child_thread");

  const delegations = await runtime.listDelegations("thread-checkpoint-split-parent");
  assert.equal(delegations.length, 1);
  const delegation = delegations[0];
  assert.equal(delegation?.parentThreadId, "thread-checkpoint-split-parent");

  const compaction = await sessionStore.listThreadCompactionEvents("thread-checkpoint-split-parent");
  const splitEvent = compaction.find((event) => event.action === "split_into_child_thread");
  assert.ok(splitEvent);
  const splitMetadata = splitEvent?.metadata as Record<string, unknown> | undefined;
  assert.equal(splitMetadata?.delegationId, delegation?.delegationId);
  assert.equal(splitMetadata?.childThreadId, delegation?.childThreadId);

  const childStatus = await runtime.getThreadStatus(delegation?.childThreadId ?? "");
  assert.equal(childStatus?.thread.parentThreadId, "thread-checkpoint-split-parent");

  const replay = await sessionStore.getReplayStream({
    runId: "run-checkpoint-split-parent",
  });
  const adaptationEvent = replay.find((event) => event.type === "context.adaptation_applied");
  assert.equal(adaptationEvent?.metadata?.action, "split_into_child_thread");
  assert.equal(adaptationEvent?.metadata?.delegationId, delegation?.delegationId);
  assert.equal(adaptationEvent?.metadata?.childThreadId, delegation?.childThreadId);
});

test("ThreadRuntime supervises multiple child launches and selects the dominant waiting blocker", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-supervision-child-1",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: { prompt: "What should child one do next?" },
        },
      }),
    },
    {
      output: buildOutput({
        runId: "run-supervision-child-2",
        status: "WAITING",
        waitFor: {
          kind: "approval",
          eventType: "user.approval",
          metadata: { prompt: "Approve the parent action?" },
        },
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text"],
    }),
  });

  await runtime.startThread({
    threadId: "thread-supervision-root",
    title: "Supervision root",
  });
  await runtime.spawnDelegation({
    parentThreadId: "thread-supervision-root",
    parentRunId: "run-supervision-root",
    title: "Child one",
    prompt: "Investigate branch one",
    launchedBy: "agent",
  });
  await runtime.spawnDelegation({
    parentThreadId: "thread-supervision-root",
    parentRunId: "run-supervision-root",
    title: "Child two",
    prompt: "Investigate branch two",
    launchedBy: "agent",
  });
  await tick();
  await tick();

  const delegations = await runtime.listDelegations("thread-supervision-root");
  assert.equal(delegations.length, 2);
  assert.equal(delegations.every((entry) => entry.status === "WAITING"), true);
  const view = await runtime.getOperatorThreadView("thread-supervision-root");
  assert.equal(view?.blocker?.kind, "child_thread");
  assert.equal(view?.nextAction?.kind, "switch_thread");
  const expectedChildThreadIds = new Set(delegations.map((entry) => entry.childThreadId));
  const expectedDelegationIds = new Set(delegations.map((entry) => entry.delegationId));
  assert.equal(expectedChildThreadIds.has(view?.childBlocker?.childThreadId ?? ""), true);
  assert.equal(expectedDelegationIds.has(view?.childBlocker?.delegationId ?? ""), true);

  const inbox = await runtime.listOperatorInbox({ threadId: "thread-supervision-root" });
  assert.equal(inbox.summary.childBlockers, 1);
  assert.equal(inbox.items.filter((item) => item.kind === "child_thread_blocker").length, 1);
});

test("ThreadRuntime treats completed multi-child fan-in as safe with no actionable child blocker", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-fanin-child-1",
        status: "COMPLETED",
      }),
    },
    {
      output: buildOutput({
        runId: "run-fanin-child-2",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text"],
    }),
  });

  await runtime.startThread({
    threadId: "thread-fanin-safe",
    title: "Safe fan-in root",
  });
  await runtime.spawnDelegation({
    parentThreadId: "thread-fanin-safe",
    parentRunId: "run-fanin-root",
    title: "Fan-in child one",
    prompt: "Complete child one",
    launchedBy: "agent",
  });
  await runtime.spawnDelegation({
    parentThreadId: "thread-fanin-safe",
    parentRunId: "run-fanin-root",
    title: "Fan-in child two",
    prompt: "Complete child two",
    launchedBy: "agent",
  });
  await tick();
  await tick();

  const delegations = await runtime.listDelegations("thread-fanin-safe");
  assert.equal(delegations.length, 2);
  assert.equal(delegations.every((entry) => entry.status === "COMPLETED"), true);

  const view = await runtime.getOperatorThreadView("thread-fanin-safe");
  assert.equal(view?.childBlocker, undefined);
  assert.equal(view?.blocker?.kind === "child_thread", false);

  const inbox = await runtime.listOperatorInbox({ threadId: "thread-fanin-safe" });
  assert.equal(inbox.summary.childBlockers, 0);
  assert.equal(inbox.items.some((item) => item.kind === "child_thread_blocker"), false);
});

test("ThreadRuntime surfaces ambiguous multi-child fan-in via context checkpoint actionability", async () => {
  const sessionStore = new InMemorySessionStore();
  const now = new Date().toISOString();
  const runtime = new ThreadRuntime({
    sessionStore,
    executor: new QueueTurnExecutor(sessionStore, []),
  });

  await sessionStore.upsertThread({
    threadId: "thread-fanin-ambiguous",
    sessionId: "session-fanin-ambiguous",
    title: "Ambiguous fan-in root",
    status: "WAITING",
    activeRunId: "run-fanin-ambiguous",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertDelegation({
    delegationId: "delegation-fanin-complete-1",
    parentThreadId: "thread-fanin-ambiguous",
    parentRunId: "run-fanin-ambiguous",
    childThreadId: "thread-fanin-ambiguous-child-1",
    title: "Completed child one",
    prompt: "Child one completed",
    launchedBy: "agent",
    status: "COMPLETED",
    resultSummary: "Result A",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertDelegation({
    delegationId: "delegation-fanin-complete-2",
    parentThreadId: "thread-fanin-ambiguous",
    parentRunId: "run-fanin-ambiguous",
    childThreadId: "thread-fanin-ambiguous-child-2",
    title: "Completed child two",
    prompt: "Child two completed",
    launchedBy: "agent",
    status: "COMPLETED",
    resultSummary: "Result B",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-fanin-ambiguous",
    threadId: "thread-fanin-ambiguous",
    runId: "run-fanin-ambiguous",
    status: "PENDING",
    recommendedAction: "operator_checkpoint",
    reason: "Child results conflict; operator must choose fan-in resolution.",
    createdAt: now,
  });

  const view = await runtime.getOperatorThreadView("thread-fanin-ambiguous");
  assert.equal(view?.blocker?.kind, "checkpoint");
  assert.equal(view?.blocker?.checkpointId, "checkpoint-fanin-ambiguous");
  assert.equal(view?.nextAction?.kind, "resolve_context_checkpoint");
  assert.equal(view?.nextAction?.checkpointId, "checkpoint-fanin-ambiguous");

  const inbox = await runtime.listOperatorInbox({ threadId: "thread-fanin-ambiguous" });
  assert.equal(inbox.items.some((item) => item.kind === "context_checkpoint"), true);
  assert.equal(inbox.summary.childBlockers, 0);
});

test("ThreadRuntime rejects repeated fan-in resolution once the checkpoint is no longer pending", async () => {
  const sessionStore = new InMemorySessionStore();
  const now = new Date().toISOString();
  const runtime = new ThreadRuntime({
    sessionStore,
    executor: new QueueTurnExecutor(sessionStore, []),
  });

  await sessionStore.upsertThread({
    threadId: "thread-fanin-resolve",
    sessionId: "session-fanin-resolve",
    title: "Resolvable fan-in root",
    status: "WAITING",
    activeRunId: "run-fanin-resolve",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-fanin-resolve",
    threadId: "thread-fanin-resolve",
    runId: "run-fanin-resolve",
    status: "PENDING",
    recommendedAction: "operator_checkpoint",
    reason: "Operator must reconcile child outcomes.",
    metadata: {
      kind: "fan_in",
      selectedDelegationIds: ["delegation-fanin-1"],
    },
    createdAt: now,
  });

  await runtime.resolveFanInCheckpoint({
    threadId: "thread-fanin-resolve",
    checkpointId: "checkpoint-fanin-resolve",
    disposition: "accept",
    issuedBy: "operator",
  });

  const events = sessionStore
    .getRunEvents()
    .filter((event) => event.runId === "run-fanin-resolve" && event.type === "delegation.reconciled");
  assert.equal(events.length, 1);

  await assert.rejects(
    () =>
      runtime.resolveFanInCheckpoint({
        threadId: "thread-fanin-resolve",
        checkpointId: "checkpoint-fanin-resolve",
        disposition: "accept",
        issuedBy: "operator",
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "OPERATOR_FAN_IN_CHECKPOINT_NOT_PENDING");
      return true;
    },
  );

  const checkpoint = await sessionStore.getContextCheckpoint("checkpoint-fanin-resolve");
  assert.equal(checkpoint?.status, "ACCEPTED");
  assert.equal(
    sessionStore
      .getRunEvents()
      .filter((event) => event.runId === "run-fanin-resolve" && event.type === "delegation.reconciled").length,
    1,
  );
});

test("ThreadRuntime auto fan-in retires older pending checkpoints once reconciliation is safe", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-auto-fanin-child-1",
        status: "COMPLETED",
      }),
    },
    {
      output: buildOutput({
        runId: "run-auto-fanin-child-2",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text"],
    }),
  });

  await runtime.startThread({
    threadId: "thread-auto-fanin",
    title: "Auto fan-in root",
  });
  await runtime.spawnDelegation({
    parentThreadId: "thread-auto-fanin",
    parentRunId: "run-thread-auto-fanin",
    title: "Auto fan-in child one",
    prompt: "Complete child one",
    launchedBy: "agent",
  });
  await tick();

  await sessionStore.upsertContextCheckpoint({
    checkpointId: fanInCheckpointId(
      "thread-auto-fanin",
      defaultSupervisionGroupId("thread-auto-fanin"),
    ),
    threadId: "thread-auto-fanin",
    runId: "run-thread-auto-fanin",
    status: "PENDING",
    recommendedAction: "operator_checkpoint",
    reason: "Initial fan-in review was required.",
    metadata: {
      kind: "fan_in",
    },
    createdAt: new Date().toISOString(),
  });

  await runtime.spawnDelegation({
    parentThreadId: "thread-auto-fanin",
    parentRunId: "run-thread-auto-fanin",
    title: "Auto fan-in child two",
    prompt: "Complete child two",
    launchedBy: "agent",
  });
  await tick();

  const checkpoint = await sessionStore.getContextCheckpoint(
    fanInCheckpointId("thread-auto-fanin", defaultSupervisionGroupId("thread-auto-fanin")),
  );
  assert.equal(checkpoint?.status, "ACCEPTED");
  assert.equal(checkpoint?.resolvedBy, "runtime");

  const view = await runtime.getOperatorThreadView("thread-auto-fanin");
  assert.notEqual(view?.latestCheckpoint?.status, "PENDING");
  assert.notEqual(view?.latestFanInDisposition?.status, "pending_checkpoint");
});

test("ThreadRuntime auto fan-in idempotency uses durable disposition instead of result summary text", async () => {
  const sessionStore = new InMemorySessionStore();
  const now = new Date().toISOString();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-auto-fanin-marker-parent",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text"],
    }),
  });

  await sessionStore.upsertThread({
    threadId: "thread-auto-fanin-marker",
    sessionId: "session-auto-fanin-marker",
    title: "Auto fan-in marker root",
    status: "WAITING",
    activeRunId: "run-auto-fanin-marker",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertDelegation({
    delegationId: "delegation-auto-fanin-marker-1",
    parentThreadId: "thread-auto-fanin-marker",
    parentRunId: "run-auto-fanin-marker",
    childThreadId: "thread-auto-fanin-marker-child-1",
    title: "Marker child one",
    prompt: "Complete child one",
    launchedBy: "agent",
    status: "COMPLETED",
    resultSummary: "Completed child [fan-in applied]",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertDelegation({
    delegationId: "delegation-auto-fanin-marker-2",
    parentThreadId: "thread-auto-fanin-marker",
    parentRunId: "run-auto-fanin-marker",
    childThreadId: "thread-auto-fanin-marker-child-2",
    title: "Marker child two",
    prompt: "Complete child two",
    launchedBy: "agent",
    status: "COMPLETED",
    resultSummary: "Completed child two",
    createdAt: now,
    updatedAt: now,
  });

  await (runtime as unknown as {
    reconcileChildSupervision(input: {
      parentThreadId: string;
      parentRunId?: string | undefined;
    }): Promise<void>;
  }).reconcileChildSupervision({
    parentThreadId: "thread-auto-fanin-marker",
    parentRunId: "run-auto-fanin-marker",
  });

  let events = sessionStore
    .getRunEvents()
    .filter((event) => event.runId === "run-auto-fanin-marker" && event.type === "delegation.reconciled");
  assert.equal(events.length, 1);
  let delegations = await runtime.listDelegations("thread-auto-fanin-marker");
  assert.equal(
    delegations.every((delegation) =>
      asRecord(asRecord(delegation.policy)?.supervision)?.latestFanInDisposition === "auto_applied",
    ),
    true,
  );

  await (runtime as unknown as {
    reconcileChildSupervision(input: {
      parentThreadId: string;
      parentRunId?: string | undefined;
    }): Promise<void>;
  }).reconcileChildSupervision({
    parentThreadId: "thread-auto-fanin-marker",
    parentRunId: "run-auto-fanin-marker",
  });

  events = sessionStore
    .getRunEvents()
    .filter((event) => event.runId === "run-auto-fanin-marker" && event.type === "delegation.reconciled");
  assert.equal(events.length, 1);
  delegations = await runtime.listDelegations("thread-auto-fanin-marker");
  assert.equal(delegations.length, 2);
});

test("ThreadRuntime resolves superseded child blockers out of actionable attention state", async () => {
  const sessionStore = new InMemorySessionStore();
  const now = new Date().toISOString();
  const runtime = new ThreadRuntime({
    sessionStore,
    executor: new QueueTurnExecutor(sessionStore, []),
  });

  await sessionStore.upsertThread({
    threadId: "thread-supersede-root",
    sessionId: "session-supersede",
    title: "Supersede root",
    status: "WAITING",
    activeRunId: "run-supersede-root",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertThread({
    threadId: "thread-supersede-child",
    sessionId: "session-supersede",
    title: "Supersede child",
    parentThreadId: "thread-supersede-root",
    status: "WAITING",
    activeRunId: "run-supersede-child",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
    },
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertDelegation({
    delegationId: "delegation-supersede",
    parentThreadId: "thread-supersede-root",
    parentRunId: "run-supersede-root",
    childThreadId: "thread-supersede-child",
    childRunId: "run-supersede-child",
    title: "Supersede delegation",
    prompt: "Pending child work",
    launchedBy: "agent",
    status: "WAITING",
    waitEventType: "user.reply",
    createdAt: now,
    updatedAt: now,
  });

  const initialInbox = await runtime.listOperatorInbox({ threadId: "thread-supersede-root" });
  assert.equal(initialInbox.summary.childBlockers, 1);
  assert.equal(initialInbox.items.some((item) => item.kind === "child_thread_blocker"), true);

  await sessionStore.upsertDelegation({
    delegationId: "delegation-supersede",
    parentThreadId: "thread-supersede-root",
    parentRunId: "run-supersede-root",
    childThreadId: "thread-supersede-child",
    childRunId: "run-supersede-child",
    title: "Supersede delegation",
    prompt: "Pending child work",
    launchedBy: "agent",
    status: "CANCELLED",
    resultSummary: "Superseded by newer child.",
    createdAt: now,
    updatedAt: new Date(Date.now() + 1000).toISOString(),
  });

  const afterInbox = await runtime.listOperatorInbox({ threadId: "thread-supersede-root" });
  assert.equal(afterInbox.summary.childBlockers, 0);
  assert.equal(afterInbox.items.some((item) => item.kind === "child_thread_blocker"), false);

  const attention = await sessionStore.listOperatorAttention({
    threadId: "thread-supersede-root",
    kind: "child_thread_blocker",
  });
  assert.equal(attention.length >= 1, true);
  assert.equal(attention.some((record) => record.status === "RESOLVED"), true);
});

test("ThreadRuntime can surface failed child delegations as the dominant blocker", async () => {
  const sessionStore = new InMemorySessionStore();
  const now = new Date().toISOString();
  const runtime = new ThreadRuntime({
    sessionStore,
    executor: new QueueTurnExecutor(sessionStore, []),
  });

  await sessionStore.upsertThread({
    threadId: "thread-failed-root",
    sessionId: "session-failed-root",
    title: "Root thread",
    status: "WAITING",
    activeRunId: "run-failed-root",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertThread({
    threadId: "thread-failed-child",
    sessionId: "session-failed-child",
    title: "Failed child",
    parentThreadId: "thread-failed-root",
    status: "FAILED",
    activeRunId: "run-failed-child",
    createdAt: now,
    updatedAt: new Date(Date.parse(now) + 1000).toISOString(),
  });
  await sessionStore.upsertDelegation({
    delegationId: "delegation-failed-child",
    parentThreadId: "thread-failed-root",
    parentRunId: "run-failed-root",
    childThreadId: "thread-failed-child",
    childRunId: "run-failed-child",
    title: "Investigate failed child",
    prompt: "Investigate failed child",
    launchedBy: "agent",
    status: "FAILED",
    errorMessage: "Child run failed before completion.",
    createdAt: now,
    updatedAt: new Date(Date.parse(now) + 1000).toISOString(),
  });

  const view = await runtime.getOperatorThreadView("thread-failed-root");
  assert.equal(view?.blocker?.kind, "child_thread");
  assert.equal(view?.childBlocker?.childThreadId, "thread-failed-child");
  assert.equal(view?.childBlocker?.status, "FAILED");
  assert.equal(view?.childBlockerChain[0]?.threadId, "thread-failed-child");

  const inbox = await runtime.listOperatorInbox({ threadId: "thread-failed-root" });
  assert.equal(inbox.items.some((item) => item.kind === "child_thread_blocker"), true);
});

test("ThreadRuntime surfaces split-created waiting children in supervision blocker truth", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-split-supervision-parent",
        status: "COMPLETED",
      }),
    },
    {
      output: buildOutput({
        runId: "run-split-supervision-child",
        status: "WAITING",
        waitFor: {
          kind: "approval",
          eventType: "user.approval",
          metadata: {
            prompt: "Approve split child action",
          },
        },
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text", "web.search"],
    }),
  });

  await runtime.startThread({
    threadId: "thread-split-supervision-parent",
    title: "Split supervision parent",
  });
  await runtime.submitTurn({
    threadId: "thread-split-supervision-parent",
    message: "baseline turn",
    eventType: "user.message",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-split-supervision",
    threadId: "thread-split-supervision-parent",
    runId: "run-split-supervision-parent",
    status: "PENDING",
    recommendedAction: "split_into_child_thread",
    reason: "Split residual objective for child supervision.",
    metadata: {
      splitPrompt: "Continue unresolved objective in child.",
      splitTitle: "Split supervision child",
    },
    createdAt: new Date().toISOString(),
  });

  await runtime.resolveContextCheckpoint({
    threadId: "thread-split-supervision-parent",
    checkpointId: "checkpoint-split-supervision",
    action: "split_into_child_thread",
    issuedBy: "operator",
  });
  await tick();

  const delegations = await runtime.listDelegations("thread-split-supervision-parent");
  assert.equal(delegations.length, 1);
  const delegation = delegations[0];
  assert.equal(delegation?.status, "WAITING");

  const view = await runtime.getOperatorThreadView("thread-split-supervision-parent");
  assert.equal(view?.blocker?.kind, "child_thread");
  assert.equal(view?.nextAction?.kind, "switch_thread");
  assert.equal(view?.childBlocker?.delegationId, delegation?.delegationId);
  assert.equal(view?.childBlocker?.childThreadId, delegation?.childThreadId);
  assert.equal(view?.childBlockerChain[0]?.threadId, delegation?.childThreadId);

  const inbox = await runtime.listOperatorInbox({ threadId: "thread-split-supervision-parent" });
  assert.equal(inbox.summary.childBlockers, 1);
  const childBlockerItem = inbox.items.find((item) => item.kind === "child_thread_blocker");
  assert.equal(childBlockerItem?.delegationId, delegation?.delegationId);
  assert.equal(childBlockerItem?.childThreadId, delegation?.childThreadId);
});

test("ThreadRuntime rejects resolving a non-pending checkpoint twice", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-checkpoint-repeat",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-checkpoint-repeat",
    title: "Checkpoint repeat",
  });
  await runtime.submitTurn({
    threadId: "thread-checkpoint-repeat",
    message: "baseline turn",
    eventType: "user.message",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-repeat",
    threadId: "thread-checkpoint-repeat",
    runId: "run-checkpoint-repeat",
    status: "PENDING",
    recommendedAction: "summarize_forward",
    reason: "Summarize before continuing.",
    createdAt: new Date().toISOString(),
  });

  await runtime.resolveContextCheckpoint({
    threadId: "thread-checkpoint-repeat",
    checkpointId: "checkpoint-repeat",
    action: "summarize_forward",
    issuedBy: "operator",
  });

  await assert.rejects(
    () =>
      runtime.resolveContextCheckpoint({
        threadId: "thread-checkpoint-repeat",
        checkpointId: "checkpoint-repeat",
        action: "summarize_forward",
        issuedBy: "operator",
      }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("already accepted"),
  );

  const artifacts = await sessionStore.listContextSummaryArtifacts("thread-checkpoint-repeat");
  assert.equal(artifacts.length, 1);
});

test("ThreadRuntime focusThread updates operator inbox focus deterministically", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-focus-parent",
        status: "WAITING",
        waitFor: {
          kind: "approval",
          eventType: "user.approval",
          metadata: {
            prompt: "Approve parent work",
          },
        },
      }),
    },
    {
      output: buildOutput({
        runId: "run-focus-child",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            prompt: "Clarify child work",
          },
        },
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-focus-parent",
    sessionId: "session-focus",
    title: "Parent",
  });
  await runtime.startThread({
    threadId: "thread-focus-child",
    sessionId: "session-focus",
    title: "Child",
    parentThreadId: "thread-focus-parent",
  });
  await runtime.submitTurn({
    threadId: "thread-focus-parent",
    message: "parent",
    eventType: "user.message",
  });
  await runtime.submitTurn({
    threadId: "thread-focus-child",
    message: "child",
    eventType: "user.message",
  });

  const before = await runtime.listOperatorInbox({
    sessionId: "session-focus",
  });
  assert.equal(before.focusThreadId, "thread-focus-parent");

  await runtime.focusThread({
    threadId: "thread-focus-child",
  });
  const after = await runtime.listOperatorInbox({
    sessionId: "session-focus",
  });
  assert.equal(after.focusThreadId, "thread-focus-child");
});

test("ThreadRuntime persists focused thread across runtime recreation with shared store", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-focus-persist-parent",
        status: "WAITING",
        waitFor: {
          kind: "approval",
          eventType: "user.approval",
          metadata: { prompt: "Approve the parent focus action?" },
        },
      }),
    },
    {
      output: buildOutput({
        runId: "run-focus-persist-child",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: { prompt: "What should the focused child do next?" },
        },
      }),
    },
  ]);

  const runtimeA = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtimeA.startThread({
    threadId: "thread-focus-persist-parent",
    sessionId: "session-focus-persist",
    title: "Focus parent",
  });
  await runtimeA.startThread({
    threadId: "thread-focus-persist-child",
    sessionId: "session-focus-persist",
    title: "Focus child",
    parentThreadId: "thread-focus-persist-parent",
  });
  await runtimeA.submitTurn({
    threadId: "thread-focus-persist-parent",
    message: "parent",
    eventType: "user.message",
  });
  await runtimeA.submitTurn({
    threadId: "thread-focus-persist-child",
    message: "child",
    eventType: "user.message",
  });
  await runtimeA.focusThread({
    threadId: "thread-focus-persist-child",
  });

  const runtimeB = new ThreadRuntime({
    sessionStore,
    executor: new QueueTurnExecutor(sessionStore, []),
  });

  const inbox = await runtimeB.listOperatorInbox({
    sessionId: "session-focus-persist",
  });
  assert.equal(inbox.focusThreadId, "thread-focus-persist-child");
});

test("ThreadRuntime surfaces dominant descendant child blocker for parent thread views", async () => {
  const sessionStore = new InMemorySessionStore();
  const now = new Date().toISOString();
  const runtime = new ThreadRuntime({
    sessionStore,
    executor: new QueueTurnExecutor(sessionStore, []),
  });

  await sessionStore.upsertThread({
    threadId: "thread-root-lineage",
    sessionId: "session-lineage",
    title: "Root",
    status: "WAITING",
    activeRunId: "run-root-lineage",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertThread({
    threadId: "thread-child-lineage",
    sessionId: "session-lineage",
    title: "Child",
    parentThreadId: "thread-root-lineage",
    status: "WAITING",
    activeRunId: "run-child-lineage",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertThread({
    threadId: "thread-grandchild-lineage",
    sessionId: "session-lineage",
    title: "Grandchild",
    parentThreadId: "thread-child-lineage",
    status: "WAITING",
    activeRunId: "run-grandchild-lineage",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
    },
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertDelegation({
    delegationId: "delegation-root-child",
    parentThreadId: "thread-root-lineage",
    parentRunId: "run-root-lineage",
    childThreadId: "thread-child-lineage",
    title: "Root -> Child",
    prompt: "Investigate child branch",
    launchedBy: "agent",
    status: "WAITING",
    waitEventType: "delegation",
    createdAt: now,
    updatedAt: now,
  });
  await sessionStore.upsertDelegation({
    delegationId: "delegation-child-grandchild",
    parentThreadId: "thread-child-lineage",
    parentRunId: "run-child-lineage",
    childThreadId: "thread-grandchild-lineage",
    title: "Child -> Grandchild",
    prompt: "Investigate deepest blocker",
    launchedBy: "agent",
    status: "WAITING",
    waitEventType: "user.reply",
    createdAt: now,
    updatedAt: now,
  });

  const view = await runtime.getOperatorThreadView("thread-root-lineage");
  assert.ok(view);
  assert.equal(view?.thread.threadId, "thread-root-lineage");
  assert.equal(view?.childBlocker?.childThreadId, "thread-grandchild-lineage");
  assert.equal(view?.childBlocker?.delegationId, "delegation-child-grandchild");
});

test("ThreadRuntime persists delegation lifecycle events under the parent session id", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-parent-delegation-child",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        summary: "Delegated work completed",
      },
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });
  const now = new Date().toISOString();

  await sessionStore.ensureSession("session-parent-delegation");
  await sessionStore.upsertThread({
    threadId: "thread-parent-delegation",
    sessionId: "session-parent-delegation",
    title: "Parent thread",
    status: "RUNNING",
    activeRunId: "run-parent-delegation",
    createdAt: now,
    updatedAt: now,
  });

  await runtime.spawnDelegation({
    parentThreadId: "thread-parent-delegation",
    parentRunId: "run-parent-delegation",
    title: "Delegated child",
    prompt: "Complete delegated task",
    launchedBy: "agent",
  });
  await tick();

  const delegationEvents = sessionStore
    .getRunEvents()
    .filter((event) => event.runId === "run-parent-delegation" && event.type.startsWith("delegation."));
  assert.ok(delegationEvents.length >= 2);
  assert.equal(
    delegationEvents.every((event) => event.sessionId === "session-parent-delegation"),
    true,
  );
});

test("ThreadRuntime exposes checkpoint disposition in operator thread view after resolution", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-checkpoint-disposition",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
  });

  await runtime.startThread({
    threadId: "thread-checkpoint-disposition",
    title: "Checkpoint disposition",
  });
  await runtime.submitTurn({
    threadId: "thread-checkpoint-disposition",
    message: "baseline",
    eventType: "user.message",
  });
  await sessionStore.upsertContextCheckpoint({
    checkpointId: "checkpoint-disposition",
    threadId: "thread-checkpoint-disposition",
    runId: "run-checkpoint-disposition",
    status: "PENDING",
    recommendedAction: "compact",
    reason: "Checkpoint for disposition",
    createdAt: new Date().toISOString(),
  });

  await runtime.resolveContextCheckpoint({
    threadId: "thread-checkpoint-disposition",
    checkpointId: "checkpoint-disposition",
    action: "compact",
    issuedBy: "operator",
  });

  const view = await runtime.getOperatorThreadView("thread-checkpoint-disposition");
  assert.equal(view?.latestCheckpoint?.status, "ACCEPTED");
  assert.equal(view?.latestCheckpoint?.resolutionAction, "compact");
  const disposition = (view as unknown as { latestCheckpointDisposition?: { status?: string; action?: string } }).latestCheckpointDisposition;
  assert.equal(disposition?.status, "ACCEPTED");
  assert.equal(disposition?.action, "compact");
});

test("ThreadRuntime composes and injects a thread-scoped runtime assembly", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-assembly-1",
        status: "COMPLETED",
      }),
    },
  ]);

  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text", "web.search"],
    }),
  });

  await runtime.startThread({
    threadId: "thread-assembly",
    title: "Assembly thread",
  });

  const status = await runtime.getThreadStatus("thread-assembly");
  assert.equal(status?.activeAssembly?.bundleId, "bundle:reference:default");
  assert.deepEqual(status?.assemblyBundle?.toolAllowlist, ["fs.read_text", "web.search"]);

  await runtime.submitTurn({
    threadId: "thread-assembly",
    message: "inspect state",
    eventType: "user.message",
  });

  const runtimeAssembly = (executor.inputs[0]?.metadata?.runtimeAssembly ?? {}) as {
    agentProfileId?: string | undefined;
    agentProfileLabel?: string | undefined;
    environmentShellKind?: string | undefined;
    environmentPresetId?: string | undefined;
    environmentCapabilityPackIds?: string[] | undefined;
    effectiveAssemblyId?: string | undefined;
    effectiveAssemblyLabel?: string | undefined;
    bundleId?: string | undefined;
    toolAllowlist?: string[] | undefined;
  };
  assert.equal(runtimeAssembly.bundleId, "bundle:reference:default");
  assert.equal(runtimeAssembly.agentProfileId, "reference");
  assert.equal(runtimeAssembly.agentProfileLabel, "Reference");
  assert.equal(runtimeAssembly.environmentShellKind, "web");
  assert.equal(runtimeAssembly.environmentPresetId, "web_balanced");
  assert.deepEqual(runtimeAssembly.environmentCapabilityPackIds, ["balanced"]);
  assert.equal(runtimeAssembly.effectiveAssemblyId, "bundle:reference:default");
  assert.equal(runtimeAssembly.effectiveAssemblyLabel, "Reference on web:web_balanced");
  assert.deepEqual(runtimeAssembly.toolAllowlist, ["fs.read_text", "web.search"]);

  const history = await runtime.listAssemblyHistory("thread-assembly");
  assert.equal(history.length >= 1, true);
  assert.equal(status?.thread.agentProfileId, "reference");
  assert.equal(status?.thread.environmentPresetId, "web_balanced");
  assert.equal(status?.thread.effectiveAssemblyId, "bundle:reference:default");
  const replay = await sessionStore.getReplayStream({
    runId: "run-assembly-1",
  });
  assert.equal(replay.some((event) => event.type === "runtime.assembly.changed"), true);
});

test("ThreadRuntime narrows inherited child assemblies and requires approval for model widening proposals", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-child-assembly-1",
        status: "COMPLETED",
      }),
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text", "web.search", "fs.write_text"],
    }),
  });

  await runtime.startThread({
    threadId: "thread-parent-assembly",
    title: "Parent assembly",
  });
  await runtime.startThread({
    threadId: "thread-child-assembly",
    title: "Child assembly",
    parentThreadId: "thread-parent-assembly",
    metadata: {
      runtimeAssembly: {
        toolAllowlist: ["fs.read_text"],
      },
    },
  });

  const childAssembly = await runtime.getActiveAssembly("thread-child-assembly");
  assert.deepEqual(childAssembly?.bundle?.toolAllowlist, ["fs.read_text"]);

  const proposal = await runtime.proposeAssemblyChange({
    threadId: "thread-child-assembly",
    requestedToolAllowlist: ["fs.read_text", "web.search"],
    proposedBy: "model",
    reason: "Need broader research tools",
  });
  assert.equal(proposal.decision.result, "APPROVAL_REQUIRED");
  assert.equal(proposal.request?.eventType, "runtime.assembly_change");

  const inbox = await runtime.listOperatorInbox({ threadId: "thread-child-assembly" });
  assert.equal(inbox.summary.assemblyProposals, 1);
  assert.equal(inbox.items.some((item) => item.kind === "assembly_change_proposal"), true);

  const requestId = proposal.request?.requestId;
  assert.ok(requestId);

  const approved = await runtime.approveAssemblyChange({
    threadId: "thread-child-assembly",
    proposalId: proposal.proposal.proposalId,
    issuedBy: "operator",
    reason: "approved",
  });
  assert.equal(approved.output.status, "COMPLETED");

  const activeAssembly = await runtime.getActiveAssembly("thread-child-assembly");
  assert.deepEqual(activeAssembly?.bundle?.toolAllowlist, ["fs.read_text", "web.search"]);

  const proposals = await sessionStore.listAssemblyChangeProposals({
    threadId: "thread-child-assembly",
  });
  assert.equal(proposals[0]?.status, "APPROVED");
  const decisions = await sessionStore.listAssemblyChangeDecisions({
    threadId: "thread-child-assembly",
  });
  assert.equal(decisions[0]?.result, "APPROVAL_REQUIRED");
  const grants = await sessionStore.listApprovalGrants({
    threadId: "thread-child-assembly",
  });
  assert.equal(grants.length, 0);
});

test("ThreadRuntime requires approval for model-originated provider changes", async () => {
  const sessionStore = new InMemorySessionStore();
  const runtime = new ThreadRuntime({
    sessionStore,
    executor: new QueueTurnExecutor(sessionStore, []),
    profile: buildProfile({
      toolAllowlist: ["fs.read_text"],
    }),
  });

  await runtime.startThread({
    threadId: "thread-provider-shift",
    title: "Provider shift",
  });

  const proposal = await runtime.proposeAssemblyChange({
    threadId: "thread-provider-shift",
    requestedProvider: "openai",
    requestedModel: "gpt-4.1-mini",
    requestedPromptVariant: "reference-react:chat:responses",
    proposedBy: "model",
    reason: "Need stricter provider contract",
  });

  assert.equal(proposal.decision.result, "APPROVAL_REQUIRED");
  assert.match(proposal.decision.reason, /provider changes require operator approval/u);
  assert.equal(proposal.proposal.requestedProvider, "openai");
  assert.equal(proposal.proposal.requestedModel, "gpt-4.1-mini");
  assert.equal(proposal.proposal.requestedPromptVariant, "reference-react:chat:responses");
  assert.equal(proposal.request?.eventType, "runtime.assembly_change");
});

test("ThreadRuntime surfaces compatibility downgrades as operator inbox alerts", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, []);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text", "web.search"],
    }),
  });

  await runtime.startThread({
    threadId: "thread-compat",
    title: "Compatibility thread",
  });

  await runtime.handleCapabilityLoss({
    threadId: "thread-compat",
    availableToolNames: ["fs.read_text"],
  });

  const inbox = await runtime.listOperatorInbox({ threadId: "thread-compat" });
  assert.equal(inbox.summary.compatibilityAlerts, 1);
  assert.equal(
    inbox.items.some((item) => item.kind === "compatibility_downgrade_attention"),
    true,
  );
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

function buildProfile(input?: { toolAllowlist?: string[] | undefined }): TuiProfile {
  return {
    id: "reference",
    label: "Reference",
    agent: "reference-react",
    sessionPrefix: "session",
    modelProvider: "openrouter",
    model: "mock-model",
    toolAllowlist: input?.toolAllowlist,
    delegation: {
      allowAgentSpawn: true,
      maxConcurrentChildSessions: 2,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
