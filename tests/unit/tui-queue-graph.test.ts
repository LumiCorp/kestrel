import assert from "node:assert/strict";
import test from "node:test";

import type { TuiSessionMeta } from "../../cli/contracts.js";
import {
  exactTuiQueueTailRunId,
  normalizeTuiQueueGraph,
  removeAndRewireTuiQueueRecord,
  TuiQueueGraphConsistencyError,
} from "../../cli/session/TuiQueueGraph.js";

function session(patch: Partial<TuiSessionMeta>): TuiSessionMeta {
  return {
    name: "queue",
    sessionId: "session-queue",
    profileId: "kestrel",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    started: true,
    acceptedRunId: "run-r0",
    ...patch,
  };
}

test("TuiQueueGraph normalizes an issue19 fork by durable journal order", () => {
  const input = session({
    queuedRunReservations: [{
      runId: "run-q1",
      messageId: "message-q1",
      threadId: "thread-main:session-queue",
      predecessorRunId: "run-r0",
    }, {
      runId: "run-q2",
      messageId: "message-q2",
      threadId: "thread-main:session-queue",
      predecessorRunId: "run-r0",
    }],
  });

  const graph = normalizeTuiQueueGraph(input);

  assert.equal(graph.queuedRunReservations?.[1]?.predecessorRunId, "run-q1");
  assert.equal(exactTuiQueueTailRunId(input, graph), "run-q2");
});

test("TuiQueueGraph rewires an exact successor before removing its predecessor", () => {
  const input = session({
    pendingQueueSubmissions: [{
      runId: "run-q1",
      messageId: "message-q1",
      threadId: "thread-main:session-queue",
      predecessorRunId: "run-r0",
    }, {
      runId: "run-q2",
      messageId: "message-q2",
      threadId: "thread-main:session-queue",
      predecessorRunId: "run-q1",
    }],
  });
  const graph = normalizeTuiQueueGraph(input);

  const rewired = removeAndRewireTuiQueueRecord(
    graph,
    graph.pendingQueueSubmissions![0]!,
  );

  assert.deepEqual(rewired.pendingQueueSubmissions, [{
    runId: "run-q2",
    messageId: "message-q2",
    threadId: "thread-main:session-queue",
    predecessorRunId: "run-r0",
  }]);
});

test("TuiQueueGraph fails closed on cycles, duplicate runs, and conflicting messages", async (t) => {
  const cases: Array<{ name: string; value: TuiSessionMeta }> = [{
    name: "cycle",
    value: session({
      queuedRunReservations: [{
        runId: "run-q1",
        messageId: "message-q1",
        threadId: "thread-main:session-queue",
        predecessorRunId: "run-q2",
      }, {
        runId: "run-q2",
        messageId: "message-q2",
        threadId: "thread-main:session-queue",
        predecessorRunId: "run-q1",
      }],
    }),
  }, {
    name: "duplicate run",
    value: session({
      pendingQueueSubmissions: [{
        runId: "run-q1",
        messageId: "message-q1",
        threadId: "thread-main:session-queue",
      }],
      queuedRunReservations: [{
        runId: "run-q1",
        messageId: "message-q1-copy",
        threadId: "thread-main:session-queue",
      }],
    }),
  }, {
    name: "conflicting message",
    value: session({
      queuedRunReservations: [{
        runId: "run-q1",
        messageId: "message-shared",
        threadId: "thread-main:session-queue",
      }, {
        runId: "run-q2",
        messageId: "message-shared",
        threadId: "thread-main:session-queue",
        predecessorRunId: "run-q1",
      }],
    }),
  }, {
    name: "ambiguous active tails",
    value: session({
      pendingQueueSubmissions: [{
        runId: "run-q1",
        messageId: "message-q1",
        threadId: "thread-main:session-queue",
        predecessorRunId: "run-r0",
      }],
      queuedRunReservations: [{
        runId: "run-q2",
        messageId: "message-q2",
        threadId: "thread-main:session-queue",
        predecessorRunId: "run-r0",
      }],
    }),
  }];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      assert.throws(
        () => normalizeTuiQueueGraph(entry.value),
        (error: unknown) => error instanceof TuiQueueGraphConsistencyError
          && error.code === "TUI_QUEUE_GRAPH_CONSISTENCY_ERROR",
      );
    });
  }
});
