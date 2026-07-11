import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedOutput } from "../../src/kestrel/contracts/execution.js";
import type { SessionRecord } from "../../src/kestrel/contracts/store.js";

import { evaluateContextAdaptation } from "../../src/orchestration/ContextAdaptationEvaluator.js";
import { ContextPolicyManager } from "../../src/orchestration/ContextPolicyManager.js";
import type { SubmitTurnResult, ThreadRecord } from "../../src/orchestration/contracts.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

class SessionStateStore extends InMemorySessionStore {
  private readonly stateOverrides = new Map<string, Record<string, unknown>>();

  setSessionState(sessionId: string, state: Record<string, unknown>): void {
    this.stateOverrides.set(sessionId, structuredClone(state));
  }

  override async getSession(sessionId: string): Promise<SessionRecord | null> {
    const session = await super.getSession(sessionId);
    if (session === null) {
      return null;
    }
    const override = this.stateOverrides.get(sessionId);
    if (override === undefined) {
      return session;
    }
    return {
      ...session,
      state: structuredClone(override),
    };
  }
}

test("evaluateContextAdaptation recommends split_into_child_thread for separable objectives under pressure", () => {
  const thread = buildThread({
    threadId: "thread-eval-split",
    metadata: {
      contextPressure: "high",
      splitPrompt: "Continue unresolved provider-specific work in a child thread.",
      splitTitle: "Provider-specific split",
      splitRecommended: true,
    },
  });
  const result = buildResult(
    thread,
    buildOutput({
      runId: "run-eval-split",
      status: "WAITING",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
      },
    }),
  );

  const evaluation = evaluateContextAdaptation({
    thread,
    result,
    session: null,
  });

  assert.equal(evaluation.disposition, "checkpoint");
  assert.equal(evaluation.recommendedAction, "split_into_child_thread");
  assert.match(String(evaluation.reason), /separable/u);
  assert.equal(evaluation.metadata?.splitPrompt, thread.metadata?.splitPrompt);
  assert.equal(evaluation.metadata?.splitTitle, thread.metadata?.splitTitle);
  assert.equal(evaluation.sourceSignals?.contextPressure, "high");
});

test("evaluateContextAdaptation recommends summarize_forward when evidence recovery is exhausted", () => {
  const thread = buildThread({
    threadId: "thread-eval-summarize",
  });
  const result = buildResult(
    thread,
    buildOutput({
      runId: "run-eval-summarize",
      status: "COMPLETED",
    }),
  );

  const evaluation = evaluateContextAdaptation({
    thread,
    result,
    session: buildSessionRecord(
      thread.sessionId,
      buildEvidenceRecoveryState({
        attempts: 4,
        lowSignalAttempts: 3,
        consecutiveLowSignal: 3,
        broadenedSearchUsed: true,
        targetedFetchUsed: true,
      }),
    ),
  });

  assert.equal(evaluation.disposition, "checkpoint");
  assert.equal(evaluation.recommendedAction, "summarize_forward");
  assert.match(String(evaluation.reason), /Evidence recovery is exhausted/u);
  assert.equal(evaluation.metadata?.summaryIntent, "research_stall_recovery");
  const evidenceSignals = evaluation.sourceSignals?.evidenceRecovery as
    | Record<string, unknown>
    | undefined;
  assert.equal(evidenceSignals?.consecutiveLowSignal, 3);
  assert.equal(evidenceSignals?.broadenedSearchUsed, true);
  assert.equal(evidenceSignals?.targetedFetchUsed, true);
});

test("ContextPolicyManager records summarize_forward checkpoints from evaluator output", async () => {
  const store = new SessionStateStore();
  const thread = buildThread({
    threadId: "thread-policy-summarize",
    sessionId: "session-policy-summarize",
    status: "COMPLETED",
    activeRunId: "run-policy-summarize",
  });
  await store.ensureSession(thread.sessionId);
  store.setSessionState(
    thread.sessionId,
    buildEvidenceRecoveryState({
      attempts: 5,
      lowSignalAttempts: 4,
      consecutiveLowSignal: 3,
      broadenedSearchUsed: true,
      targetedFetchUsed: true,
    }),
  );
  await store.upsertThread(thread);
  const manager = new ContextPolicyManager(store);

  await manager.recordPostTurn({
    thread,
    result: buildResult(
      thread,
      buildOutput({
        runId: "run-policy-summarize",
        status: "COMPLETED",
      }),
    ),
    decision: {
      action: "continue",
      reason: "No immediate compaction policy action.",
    },
  });

  const checkpoints = await store.listContextCheckpoints({
    threadId: thread.threadId,
  });
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.recommendedAction, "summarize_forward");
  assert.equal(checkpoints[0]?.status, "PENDING");
  assert.equal(checkpoints[0]?.metadata?.summaryIntent, "research_stall_recovery");

  const checkpointEvents = store
    .getRunEvents()
    .filter((event) => event.runId === "run-policy-summarize" && event.type === "context.checkpoint_requested");
  assert.equal(checkpointEvents.length, 1);
  assert.equal(checkpointEvents[0]?.metadata?.recommendedAction, "summarize_forward");
  assert.equal(checkpointEvents[0]?.metadata?.checkpointId, checkpoints[0]?.checkpointId);
});

test("ContextPolicyManager records split_into_child_thread checkpoints when capability loss coincides with pressure", async () => {
  const store = new SessionStateStore();
  const thread = buildThread({
    threadId: "thread-policy-split",
    sessionId: "session-policy-split",
    status: "WAITING",
    activeRunId: "run-policy-split",
    metadata: {
      contextPressure: "critical",
      splitPrompt: "Split unresolved capability-restricted tasks to a child thread.",
      splitTitle: "Capability split",
      splitRecommended: true,
    },
  });
  await store.ensureSession(thread.sessionId);
  await store.upsertThread(thread);
  const manager = new ContextPolicyManager(store);

  await manager.recordPostTurn({
    thread,
    result: buildResult(
      thread,
      buildOutput({
        runId: "run-policy-split",
        status: "WAITING",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            reason: "capability_loss",
          },
        },
      }),
    ),
    decision: {
      action: "continue",
      reason: "Continue unless adaptation requires operator checkpoint.",
    },
  });

  const checkpoints = await store.listContextCheckpoints({
    threadId: thread.threadId,
  });
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.recommendedAction, "split_into_child_thread");
  assert.equal(checkpoints[0]?.metadata?.splitPrompt, thread.metadata?.splitPrompt);
  assert.equal(checkpoints[0]?.metadata?.splitTitle, thread.metadata?.splitTitle);
  assert.match(String(checkpoints[0]?.reason), /Capability loss/u);
  assert.equal(checkpoints[0]?.signals?.contextPressure, "critical");
  assert.equal(checkpoints[0]?.signals?.capabilityLoss, true);
});

test("ContextPolicyManager refreshes the newest matching pending checkpoint in place", async () => {
  const store = new SessionStateStore();
  const thread = buildThread({
    threadId: "thread-policy-refresh",
    sessionId: "session-policy-refresh",
    status: "COMPLETED",
    activeRunId: "run-policy-refresh-current",
  });
  await store.ensureSession(thread.sessionId);
  store.setSessionState(
    thread.sessionId,
    buildEvidenceRecoveryState({
      attempts: 5,
      lowSignalAttempts: 4,
      consecutiveLowSignal: 3,
      broadenedSearchUsed: true,
      targetedFetchUsed: true,
    }),
  );
  await store.upsertThread(thread);
  await store.upsertContextCheckpoint({
    checkpointId: "checkpoint-policy-refresh",
    threadId: thread.threadId,
    runId: "run-policy-refresh-old",
    status: "PENDING",
    recommendedAction: "summarize_forward",
    reason: "Evidence recovery is exhausted; summarize the verified work before continuing.",
    createdAt: "2026-03-17T00:00:00.000Z",
  });
  const manager = new ContextPolicyManager(store);

  await manager.recordPostTurn({
    thread,
    result: buildResult(
      thread,
      buildOutput({
        runId: "run-policy-refresh-next",
        status: "COMPLETED",
      }),
    ),
    decision: {
      action: "continue",
      reason: "No immediate compaction policy action.",
    },
  });

  const checkpoints = await store.listContextCheckpoints({
    threadId: thread.threadId,
  });
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.checkpointId, "checkpoint-policy-refresh");
  assert.equal(checkpoints[0]?.runId, "run-policy-refresh-next");
  assert.equal(checkpoints[0]?.status, "PENDING");
  assert.equal(typeof checkpoints[0]?.metadata?.reasonClass, "string");
});

test("ContextPolicyManager supersedes older pending non-fan-in checkpoints and preserves fan-in lifecycle", async () => {
  const store = new SessionStateStore();
  const thread = buildThread({
    threadId: "thread-policy-supersede",
    sessionId: "session-policy-supersede",
    status: "COMPLETED",
    activeRunId: "run-policy-supersede-current",
  });
  await store.ensureSession(thread.sessionId);
  store.setSessionState(
    thread.sessionId,
    buildEvidenceRecoveryState({
      attempts: 5,
      lowSignalAttempts: 4,
      consecutiveLowSignal: 3,
      broadenedSearchUsed: true,
      targetedFetchUsed: true,
    }),
  );
  await store.upsertThread(thread);
  await store.upsertContextCheckpoint({
    checkpointId: "checkpoint-policy-old-non-fanin",
    threadId: thread.threadId,
    runId: "run-policy-old",
    status: "PENDING",
    recommendedAction: "compact",
    reason: "Thread is thrashing and should compact before more work continues.",
    createdAt: "2026-03-17T00:00:00.000Z",
  });
  await store.upsertContextCheckpoint({
    checkpointId: "checkpoint-policy-old-fanin",
    threadId: thread.threadId,
    runId: "run-policy-fanin",
    status: "PENDING",
    recommendedAction: "operator_checkpoint",
    reason: "Fan-in needs manual review.",
    metadata: {
      kind: "fan_in",
    },
    createdAt: "2026-03-17T00:00:01.000Z",
  });
  const manager = new ContextPolicyManager(store);

  await manager.recordPostTurn({
    thread,
    result: buildResult(
      thread,
      buildOutput({
        runId: "run-policy-supersede-next",
        status: "COMPLETED",
      }),
    ),
    decision: {
      action: "continue",
      reason: "No immediate compaction policy action.",
    },
  });

  const checkpoints = await store.listContextCheckpoints({
    threadId: thread.threadId,
  });
  const nextPending = checkpoints.find(
    (entry) => entry.status === "PENDING" && entry.metadata?.kind !== "fan_in",
  );
  assert.notEqual(nextPending, undefined);
  const superseded = checkpoints.find((entry) => entry.checkpointId === "checkpoint-policy-old-non-fanin");
  assert.equal(superseded?.status, "DEFERRED");
  assert.equal(superseded?.resolutionAction, "continue");
  assert.equal(superseded?.resolvedBy, "policy");
  assert.equal(
    superseded?.metadata?.supersededByCheckpointId,
    nextPending?.checkpointId,
  );
  assert.equal(typeof superseded?.metadata?.supersededAt, "string");
  const fanIn = checkpoints.find((entry) => entry.checkpointId === "checkpoint-policy-old-fanin");
  assert.equal(fanIn?.status, "PENDING");
  assert.equal(fanIn?.metadata?.kind, "fan_in");
});

function buildThread(input: {
  threadId: string;
  sessionId?: string | undefined;
  status?: ThreadRecord["status"] | undefined;
  activeRunId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}): ThreadRecord {
  const now = "2026-03-17T00:00:00.000Z";
  return {
    threadId: input.threadId,
    sessionId: input.sessionId ?? input.threadId,
    title: input.threadId,
    status: input.status ?? "RUNNING",
    ...(input.activeRunId !== undefined ? { activeRunId: input.activeRunId } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function buildOutput(input: {
  runId: string;
  status: NormalizedOutput["status"];
  waitFor?: NormalizedOutput["waitFor"] | undefined;
  thrashIndex?: number | undefined;
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
      thrashIndex: input.thrashIndex ?? 0,
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

function buildResult(thread: ThreadRecord, output: NormalizedOutput): SubmitTurnResult {
  return {
    thread,
    output,
  };
}

function buildSessionRecord(sessionId: string, state: Record<string, unknown>): SessionRecord {
  return {
    sessionId,
    version: 1,
    currentStepAgent: "react.exec.dispatch",
    state,
    updatedAt: "2026-03-17T00:00:00.000Z",
  };
}

function buildEvidenceRecoveryState(input: {
  attempts: number;
  lowSignalAttempts: number;
  consecutiveLowSignal: number;
  broadenedSearchUsed: boolean;
  targetedFetchUsed: boolean;
}): Record<string, unknown> {
  return {
    react: {
      postToolVerification: {
        evidenceRecoverySummary: {
          objectiveKey: "research-objective",
          family: "news_research",
          attempts: input.attempts,
          lowSignalAttempts: input.lowSignalAttempts,
          consecutiveLowSignal: input.consecutiveLowSignal,
          broadenedSearchUsed: input.broadenedSearchUsed,
          targetedFetchUsed: input.targetedFetchUsed,
        },
      },
    },
  };
}
