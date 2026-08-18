import test from "node:test";
import assert from "node:assert/strict";

import type {
  ClaimConversationTurnExecutionInput,
} from "../../src/kestrel/contracts/store.js";
import { InMemorySessionStore as RuntimeInMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

async function createStore(): Promise<InMemorySessionStore> {
  const store = new InMemorySessionStore();
  await store.ensureSession("session-lifecycle", "agent.loop");
  await store.upsertThread({
    threadId: "thread-lifecycle",
    sessionId: "session-lifecycle",
    title: "Lifecycle",
    status: "IDLE",
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
  });
  return store;
}

function claimInput(overrides: Partial<ClaimConversationTurnExecutionInput> = {}): ClaimConversationTurnExecutionInput {
  const runId = overrides.proposedRunId ?? "run-lifecycle-1";
  const submissionIdentity = overrides.submissionIdentity ?? "submission-initial";
  return {
    turnId: "turn-lifecycle",
    threadId: "thread-lifecycle",
    sessionId: "session-lifecycle",
    turnRequestIdentity: "turn-request",
    submissionIdentity,
    submissionKind: "initial",
    proposedRunId: runId,
    eventType: "user.message",
    startedAt: "2026-07-30T12:01:00.000Z",
    ...overrides,
    segment: overrides.segment ?? {
      segmentId: `segment-${submissionIdentity}`,
      turnId: "turn-lifecycle",
      threadId: "thread-lifecycle",
      sessionId: "session-lifecycle",
      runId,
      kind: "submission",
      eventType: "user.message",
      messageHash: "message-hash",
      createdAt: "2026-07-30T12:01:00.000Z",
      metadata: { submissionIdentity },
    },
  };
}

test("conversation turn claim creates one actual prestarted run", async () => {
  const store = await createStore();
  const [left, right] = await Promise.all([
    store.claimConversationTurnExecution(claimInput()),
    store.claimConversationTurnExecution(claimInput({ proposedRunId: "run-lifecycle-race" })),
  ]);

  assert.equal([left.kind, right.kind].filter((kind) => kind === "claimed").length, 1);
  const claimed = left.kind === "claimed" ? left : right;
  const duplicate = left.kind === "already_running" ? left : right;
  assert.equal(claimed.kind, "claimed");
  assert.equal(duplicate.kind, "already_running");
  if (claimed.kind !== "claimed" || duplicate.kind !== "already_running") {
    throw new Error("Expected one claimed and one already-running result.");
  }
  assert.equal(duplicate.runId, claimed.runId);
  await store.validatePrestartedRun(claimed.runId, {
    id: "event-id-is-independent",
    type: "user.message",
    sessionId: "session-lifecycle",
    payload: {},
  });
  assert.notEqual(claimed.runId, "event-id-is-independent");
});

test("orphan recovery fails run turn and thread before releasing the lease", async () => {
  const store = new RuntimeInMemorySessionStore();
  await store.ensureSession("session-lifecycle", "agent.loop");
  await store.upsertThread({
    threadId: "thread-lifecycle",
    sessionId: "session-lifecycle",
    title: "Lifecycle",
    status: "IDLE",
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
  });
  await store.claimConversationTurnExecution(claimInput());

  assert.deepEqual(
    await store.recoverOrphanedActiveRun("session-lifecycle"),
    { runId: "run-lifecycle-1" },
  );
  assert.equal((await store.getRun("run-lifecycle-1"))?.status, "FAILED");
  assert.equal((await store.getConversationTurn("turn-lifecycle"))?.status, "FAILED");
  assert.equal((await store.getThread("thread-lifecycle"))?.status, "FAILED");
  assert.equal(
    store.operationLog.includes("leaseReleased:session-lifecycle:run-lifecycle-1"),
    true,
  );
});

test("atomic wait settlement and resume keep run turn thread and lease aligned", async () => {
  const store = await createStore();
  await store.claimConversationTurnExecution(claimInput());
  await store.completeRun("run-lifecycle-1", "WAITING", undefined, {
    wait: {
      kind: "region_merge",
      eventType: "region.completed",
      timeoutMs: 9_000,
      reason: "wait for children",
      resumeInstruction: "resume after region completion",
      resumeStepAgent: "agent.exec.wait_region",
      resumeToken: "region-token",
      metadata: { regionId: "region-a" },
    },
  });

  assert.equal((await store.getRun("run-lifecycle-1"))?.status, "WAITING");
  assert.equal((await store.getConversationTurn("turn-lifecycle"))?.status, "WAITING");
  const waitingThread = await store.getThread("thread-lifecycle");
  assert.equal(waitingThread?.status, "WAITING");
  assert.equal(waitingThread?.waitFor?.kind, "region_merge");
  assert.equal(waitingThread?.waitFor?.timeoutMs, 9_000);

  const resumed = await store.claimConversationTurnExecution(claimInput({
    proposedRunId: "run-lifecycle-2",
    submissionIdentity: "submission-resume",
    submissionKind: "resume",
    eventType: "region.completed",
    segment: {
      ...claimInput().segment,
      segmentId: "segment-submission-resume",
      runId: "run-lifecycle-2",
      kind: "resume",
      eventType: "region.completed",
      metadata: { submissionIdentity: "submission-resume" },
    },
  }));
  assert.deepEqual(resumed, { kind: "claimed", runId: "run-lifecycle-2" });
  const runningThread = await store.getThread("thread-lifecycle");
  assert.equal(runningThread?.status, "RUNNING");
  assert.equal(runningThread?.activeRunId, "run-lifecycle-2");
  assert.equal(runningThread?.waitFor, undefined);
});

test("resume reconciles a durable waiting run with stale running projections", async () => {
  const store = await createStore();
  const event = {
    id: "event-lifecycle-wait",
    type: "user.message",
    sessionId: "session-lifecycle",
    payload: {},
  };
  await store.claimConversationTurnExecution(claimInput());
  await store.commitStep({
    runId: "run-lifecycle-1",
    event,
    sessionId: "session-lifecycle",
    expectedVersion: 0,
    stepAgent: "agent.loop",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        waitingFor: {
          source: "waitingFor",
          kind: "user",
          eventType: "user.message",
          reason: "need input",
          resumeInstruction: "reply to continue",
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });
  await store.completeRun("run-lifecycle-1", "WAITING", undefined, {
    wait: {
      kind: "user",
      eventType: "user.message",
      reason: "need input",
      resumeInstruction: "reply to continue",
    },
  });
  const settledTurn = await store.getConversationTurn("turn-lifecycle");
  const settledThread = await store.getThread("thread-lifecycle");
  assert.ok(settledTurn);
  assert.ok(settledThread);
  await store.upsertConversationTurn({
    ...settledTurn,
    status: "RUNNING",
    activeRunId: "run-lifecycle-1",
    terminalRunId: undefined,
    terminalStatus: undefined,
    completedAt: undefined,
  });
  await store.upsertThread({
    ...settledThread,
    status: "RUNNING",
    activeRunId: "run-lifecycle-1",
    lastRunStatus: "RUNNING",
    waitFor: undefined,
  });

  const resumed = await store.claimConversationTurnExecution(claimInput({
    proposedRunId: "run-lifecycle-2",
    submissionIdentity: "submission-recovered-resume",
    submissionKind: "resume",
    segment: {
      ...claimInput().segment,
      segmentId: "segment-submission-recovered-resume",
      runId: "run-lifecycle-2",
      kind: "resume",
      metadata: { submissionIdentity: "submission-recovered-resume" },
    },
  }));

  assert.deepEqual(resumed, { kind: "claimed", runId: "run-lifecycle-2" });
  assert.equal((await store.getRun("run-lifecycle-1"))?.status, "WAITING");
  assert.equal((await store.getConversationTurn("turn-lifecycle"))?.status, "RUNNING");
  assert.equal((await store.getThread("thread-lifecycle"))?.activeRunId, "run-lifecycle-2");
});

test("post-run enrichment cannot overwrite a resumed run", async () => {
  const store = await createStore();
  await store.claimConversationTurnExecution(claimInput());
  await store.completeRun("run-lifecycle-1", "WAITING", undefined, {
    wait: {
      kind: "user",
      eventType: "user.message",
      reason: "need input",
      resumeInstruction: "reply to continue",
    },
  });
  const oldThread = await store.getThread("thread-lifecycle");
  assert.ok(oldThread);
  await store.claimConversationTurnExecution(claimInput({
    proposedRunId: "run-lifecycle-2",
    submissionIdentity: "submission-resume",
    submissionKind: "resume",
    segment: {
      ...claimInput().segment,
      segmentId: "segment-submission-resume",
      runId: "run-lifecycle-2",
      kind: "resume",
      metadata: { submissionIdentity: "submission-resume" },
    },
  }));

  const updated = await store.updateThreadAfterRun({
    thread: {
      ...oldThread,
      status: "WAITING",
      activeRunId: "run-lifecycle-1",
    },
    turnId: "turn-lifecycle",
    runId: "run-lifecycle-1",
  });
  assert.equal(updated, false);
  assert.equal((await store.getThread("thread-lifecycle"))?.activeRunId, "run-lifecycle-2");
});

test("resume submissions cannot replace the immutable turn request identity", async () => {
  const store = await createStore();
  await store.claimConversationTurnExecution(claimInput());
  await store.completeRun("run-lifecycle-1", "WAITING", undefined, {
    wait: {
      kind: "user",
      eventType: "user.message",
      reason: "need input",
      resumeInstruction: "reply to continue",
    },
  });

  await assert.rejects(
    store.claimConversationTurnExecution(claimInput({
      turnRequestIdentity: "different-turn-request",
      submissionIdentity: "submission-resume",
      submissionKind: "resume",
      proposedRunId: "run-lifecycle-2",
      segment: {
        ...claimInput().segment,
        segmentId: "segment-submission-resume",
        runId: "run-lifecycle-2",
        kind: "resume",
        metadata: { submissionIdentity: "submission-resume" },
      },
    })),
    (error: unknown) =>
      (error as { code?: unknown } | undefined)?.code ===
        "CONVERSATION_TURN_IDENTITY_CONFLICT",
  );
  assert.equal(await store.getRun("run-lifecycle-2"), null);
});

test("atomic suspension projects every canonical wait kind without a running lease", async () => {
  for (const kind of ["approval", "user", "effect", "tool", "region_merge"] as const) {
    const store = await createStore();
    await store.claimConversationTurnExecution(claimInput());
    await store.completeRun("run-lifecycle-1", "WAITING", undefined, {
      wait: {
        kind,
        eventType: `${kind}.ready`,
        timeoutMs: 1_500,
        reason: `wait for ${kind}`,
        resumeInstruction: `resume ${kind}`,
        resumeStepAgent: "agent.loop",
        resumeToken: `token-${kind}`,
        metadata: { kind },
        ...(kind === "approval" || kind === "user"
          ? {
              interaction: {
                version: "v1",
                requestId: `request-${kind}`,
                kind: kind === "approval" ? "approval" : "user_input",
                eventType: `${kind}.ready`,
                prompt: `Resolve ${kind}`,
              },
            }
          : {}),
      },
    });

    const turn = await store.getConversationTurn("turn-lifecycle");
    const thread = await store.getThread("thread-lifecycle");
    assert.equal((await store.getRun("run-lifecycle-1"))?.status, "WAITING");
    assert.equal(turn?.status, "WAITING");
    assert.equal(thread?.status, "WAITING");
    assert.equal(thread?.lastRunStatus, "WAITING");
    assert.equal(thread?.waitFor?.kind, kind);
    assert.equal(thread?.waitFor?.timeoutMs, 1_500);
    const suspensionEnvelope = turn?.metadata?.suspensionEnvelope as
      | { wait?: { resumeToken?: string } }
      | undefined;
    assert.equal(suspensionEnvelope?.wait?.resumeToken, `token-${kind}`);
  }
});

test("atomic terminal settlement leaves a pending replay envelope without a running projection", async () => {
  const store = await createStore();
  await store.claimConversationTurnExecution(claimInput());
  await store.completeRun("run-lifecycle-1", "COMPLETED");

  const turn = await store.getConversationTurn("turn-lifecycle");
  const thread = await store.getThread("thread-lifecycle");
  assert.equal(turn?.status, "COMPLETED");
  assert.equal(turn?.activeRunId, undefined);
  assert.equal(thread?.status, "COMPLETED");
  assert.equal(thread?.activeRunId, undefined);

  const replay = await store.claimConversationTurnExecution(claimInput({
    proposedRunId: "run-must-not-start",
  }));
  assert.equal(replay.kind, "terminal");
  if (replay.kind === "terminal") {
    assert.equal(replay.terminalEnvelope.handoff.state, "pending");
    assert.equal(replay.terminalEnvelope.runId, "run-lifecycle-1");
  }
  assert.equal(await store.getRun("run-must-not-start"), null);
});

test("terminal handoff enrichment cannot overwrite a newer active turn", async () => {
  const store = await createStore();
  await store.claimConversationTurnExecution(claimInput());
  await store.completeRun("run-lifecycle-1", "COMPLETED");
  const firstTurn = await store.getConversationTurn("turn-lifecycle");
  const pendingEnvelope = firstTurn?.metadata?.terminalEnvelope;
  assert.equal(
    (pendingEnvelope as { handoff?: { state?: string } } | undefined)?.handoff?.state,
    "pending",
  );

  await store.claimConversationTurnExecution({
    ...claimInput(),
    turnId: "turn-lifecycle-2",
    turnRequestIdentity: "turn-request-2",
    submissionIdentity: "submission-initial-2",
    proposedRunId: "run-lifecycle-2",
    segment: {
      ...claimInput().segment,
      segmentId: "segment-submission-initial-2",
      turnId: "turn-lifecycle-2",
      runId: "run-lifecycle-2",
      metadata: { submissionIdentity: "submission-initial-2" },
    },
  });

  const enriched = await store.updateConversationTurnTerminalEnvelope({
    turnId: "turn-lifecycle",
    runId: "run-lifecycle-1",
    terminalSubmissionIdentity: "submission-initial",
    envelope: {
      ...(pendingEnvelope as {
        version: "v1";
        turnRequestIdentity: string;
        terminalSubmissionIdentity: string;
        runId: string;
        status: "COMPLETED";
      }),
      output: {
        status: "COMPLETED",
        sessionId: "session-lifecycle",
        runId: "run-lifecycle-1",
        quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
        errors: [],
        telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
      },
      handoff: { state: "delivered", assistantText: "done" },
    },
  });
  assert.equal(enriched, true);
  const activeThread = await store.getThread("thread-lifecycle");
  assert.equal(activeThread?.activeRunId, "run-lifecycle-2");
  assert.equal(activeThread?.metadata?.activeTurnId, "turn-lifecycle-2");
  assert.equal(activeThread?.metadata?.terminalEnvelope, undefined);
});

test("missing claimed run is failed instead of stranded", async () => {
  const store = await createStore();
  await store.upsertConversationTurn({
    turnId: "turn-lifecycle",
    threadId: "thread-lifecycle",
    sessionId: "session-lifecycle",
    rootRunId: "missing-run",
    activeRunId: "missing-run",
    status: "RUNNING",
    initialEventType: "user.message",
    startedAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
    metadata: {
      executionClaim: {
        turnRequestIdentity: "turn-request",
        submissionIdentity: "submission-initial",
      },
    },
  });
  const thread = await store.getThread("thread-lifecycle");
  assert.ok(thread);
  await store.upsertThread({
    ...thread,
    status: "RUNNING",
    activeRunId: "missing-run",
    metadata: {
      ...(thread.metadata ?? {}),
      activeTurnId: "turn-lifecycle",
    },
  });

  const result = await store.claimConversationTurnExecution(claimInput({
    proposedRunId: "run-recovery-attempt",
    submissionIdentity: "submission-recovery",
    submissionKind: "resume",
  }));
  assert.equal(result.kind, "terminal");
  assert.equal((await store.getConversationTurn("turn-lifecycle"))?.status, "FAILED");
  assert.equal((await store.getThread("thread-lifecycle"))?.status, "FAILED");
});

test("runtime in-memory terminal outcome pages exclude pending handoffs before limiting", async () => {
  const store = new RuntimeInMemorySessionStore();
  const turn = (
    turnId: string,
    completedAt: string,
    updatedAt: string,
    handoffState: "delivered" | "failed" | "pending",
  ) => ({
    turnId,
    threadId: "thread-terminal-page",
    sessionId: "session-terminal-page",
    rootRunId: `run-${turnId}`,
    status: handoffState === "failed" ? "FAILED" as const : "COMPLETED" as const,
    initialEventType: "user.message",
    startedAt: "2026-08-17T10:00:00.000Z",
    updatedAt,
    completedAt,
    metadata: {
      terminalEnvelope: {
        version: "v1",
        turnRequestIdentity: `request-${turnId}`,
        terminalSubmissionIdentity: `submission-${turnId}`,
        runId: `run-${turnId}`,
        status: handoffState === "failed" ? "FAILED" : "COMPLETED",
        handoff: handoffState === "failed"
          ? { state: "failed", finalizationError: { code: "FINALIZATION_FAILED", message: "failed" } }
          : handoffState === "delivered"
            ? { state: "delivered", assistantText: "done" }
            : { state: "pending" },
      },
    },
  });
  await Promise.all([
    store.upsertConversationTurn(turn(
      "turn-pending",
      "2026-08-17T10:05:00.000Z",
      "2026-08-17T10:20:00.000Z",
      "pending",
    )),
    store.upsertConversationTurn(turn(
      "turn-newest",
      "2026-08-17T10:04:00.000Z",
      "2026-08-17T10:04:00.000Z",
      "delivered",
    )),
    store.upsertConversationTurn(turn(
      "turn-next",
      "2026-08-17T10:03:00.000Z",
      "2026-08-17T10:03:00.000Z",
      "failed",
    )),
    store.upsertConversationTurn(turn(
      "turn-older",
      "2026-08-17T10:02:00.000Z",
      "2026-08-17T10:30:00.000Z",
      "delivered",
    )),
  ]);

  const initial = await store.listConversationTurns({
    threadId: "thread-terminal-page",
    terminalOutcomesOnly: true,
    limit: 2,
  });
  const cursor = await store.listConversationTurns({
    threadId: "thread-terminal-page",
    terminalOutcomesOnly: true,
    completedAfter: {
      completedAt: "2026-08-17T10:02:00.000Z",
      turnId: "turn-older",
    },
    limit: 5,
  });

  assert.deepEqual(initial.map((entry) => entry.turnId), ["turn-newest", "turn-next"]);
  assert.deepEqual(cursor.map((entry) => entry.turnId), ["turn-next", "turn-newest"]);
});
