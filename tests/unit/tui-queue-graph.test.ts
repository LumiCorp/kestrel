import assert from "node:assert/strict";
import test from "node:test";

import type { TuiSessionMeta } from "../../cli/contracts.js";
import {
  advanceTuiQueueAuthority,
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

test("TuiQueueGraph preserves a legacy reservation fork until exact authority resolves it", () => {
  const input = session({
    queuedRunReservations: [{
      runId: "run-q2",
      messageId: "message-q2",
      threadId: "thread-main:session-queue",
      predecessorRunId: "run-r0",
    }, {
      runId: "run-q1",
      messageId: "message-q1",
      threadId: "thread-main:session-queue",
      predecessorRunId: "run-r0",
    }],
  });

  const graph = normalizeTuiQueueGraph(input);

  assert.deepEqual(graph.queuedRunReservations, input.queuedRunReservations);
  assert.throws(() => exactTuiQueueTailRunId(input, graph), TuiQueueGraphConsistencyError);

  const advanced = advanceTuiQueueAuthority(graph, graph.queuedRunReservations![1]!);
  assert.deepEqual(advanced.queuedRunReservations, [{
    runId: "run-q2",
    messageId: "message-q2",
    threadId: "thread-main:session-queue",
    predecessorRunId: "run-q1",
  }]);
});

test("TuiQueueGraph uses durable order only for pending submission journals", () => {
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
      predecessorRunId: "run-r0",
    }],
  });

  const graph = normalizeTuiQueueGraph(input);

  assert.equal(graph.pendingQueueSubmissions?.[1]?.predecessorRunId, "run-q1");
  assert.equal(exactTuiQueueTailRunId(input, graph), "run-q2");
});

test("TuiQueueGraph repairs an accepted terminal sibling from exact authority", () => {
  const input = session({
    acceptedRunId: "run-q1",
    acceptedRunMessageId: "message-q1",
    acceptedRunThreadId: "thread-main:session-queue",
    queuedRunReservations: [{
      runId: "run-q2",
      messageId: "message-q2",
      threadId: "thread-main:session-queue",
      predecessorRunId: "run-r0",
    }],
    terminalQueuedRuns: [{
      runId: "run-q1",
      messageId: "message-q1",
      threadId: "thread-main:session-queue",
      predecessorRunId: "run-r0",
      status: "COMPLETED",
    }],
  });

  assert.equal(
    normalizeTuiQueueGraph(input).queuedRunReservations?.[0]?.predecessorRunId,
    "run-q1",
  );
});

test("TuiQueueGraph rejects a dangling active predecessor before extension", () => {
  const value = session({
    queuedRunReservations: [{
      runId: "run-q2",
      messageId: "message-q2",
      threadId: "thread-main:session-queue",
      predecessorRunId: "run-missing-q1",
    }],
  });
  assert.throws(
    () => exactTuiQueueTailRunId(value, normalizeTuiQueueGraph(value)),
    TuiQueueGraphConsistencyError,
  );
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

test("TuiQueueGraph blocks ambiguous active tails from extension", () => {
  const value = session({
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
  });
  const graph = normalizeTuiQueueGraph(value);

  assert.throws(
    () => exactTuiQueueTailRunId(value, graph),
    TuiQueueGraphConsistencyError,
  );
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
