import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadRecord } from "../../src/kestrel/contracts/orchestration.js";

import type { ProductTaskGraph } from "../../src/taskGraph/contracts.js";
import type {
  OperatorInboxSnapshot,
  OperatorThreadView,
  ThreadStatusSnapshot,
} from "../../src/orchestration/contracts.js";
import {
  buildRuntimeTaskGraphProjection,
  readRuntimeTaskGraphProjectionContext,
  type RuntimeTaskGraphProjectionRuntime,
} from "../../src/index.js";

test("buildRuntimeTaskGraphProjection reads thread context and renders graph through the store", async () => {
  const thread = buildThread("thread-main", "session-main");
  const status = buildThreadStatus(thread);
  const inbox = buildInbox(thread.threadId);
  const operatorView: OperatorThreadView = {
    thread,
    childThreads: [],
    childBlockerChain: [],
    nextAction: {
      kind: "reply",
      summary: "Continue",
    },
  };
  const renderedGraph: ProductTaskGraph = {
    version: 1,
    rootTaskIds: ["task-main"],
    tasks: {},
  };
  let graphInput:
    | {
        sessionId: string;
        thread?: ThreadRecord | undefined;
        operatorView?: OperatorThreadView | undefined;
        operatorInbox?: OperatorInboxSnapshot | undefined;
      }
    | undefined;

  const projection = await buildRuntimeTaskGraphProjection({
    sessionId: "session-main",
    session: {
      sessionId: "session-main",
      version: 5,
      updatedAt: "2026-05-24T18:00:00.000Z",
      state: {},
    },
    threadId: thread.threadId,
    threadRuntime: new FakeTaskGraphProjectionRuntime({
      statuses: [status],
      views: [operatorView],
      inbox,
    }),
    taskGraphStore: {
      async getGraph(input) {
        graphInput = input;
        return renderedGraph;
      },
    },
  });

  assert.equal(projection.sessionId, "session-main");
  assert.equal(projection.version, 5);
  assert.equal(projection.graph, renderedGraph);
  assert.equal(graphInput?.sessionId, "session-main");
  assert.equal(graphInput?.thread, thread);
  assert.equal(graphInput?.operatorView, operatorView);
  assert.equal(graphInput?.operatorInbox, inbox);
});

test("buildRuntimeTaskGraphProjection returns empty graph without a task graph store", async () => {
  const projection = await buildRuntimeTaskGraphProjection({
    sessionId: "session-minimal",
    session: null,
  });

  assert.deepEqual(projection, {
    sessionId: "session-minimal",
    version: 0,
    graph: {
      version: 1,
      rootTaskIds: [],
      tasks: {},
    },
  });
});

test("readRuntimeTaskGraphProjectionContext reuses an existing operator view for the same thread", async () => {
  const thread = buildThread("thread-main", "session-main");
  const operatorView: OperatorThreadView = {
    thread,
    childThreads: [],
    childBlockerChain: [],
  };
  const runtime = new FakeTaskGraphProjectionRuntime({
    statuses: [buildThreadStatus(thread)],
    views: [operatorView],
    inbox: buildInbox(thread.threadId),
  });

  const context = await readRuntimeTaskGraphProjectionContext({
    threadId: thread.threadId,
    threadRuntime: runtime,
    operatorView,
  });

  assert.equal(context.thread, thread);
  assert.equal(context.operatorView, operatorView);
  assert.equal(context.operatorInbox?.focusThreadId, thread.threadId);
  assert.deepEqual(runtime.viewLookups, []);
});

class FakeTaskGraphProjectionRuntime implements RuntimeTaskGraphProjectionRuntime {
  private readonly statusesByThreadId: Map<string, ThreadStatusSnapshot>;
  private readonly viewsByThreadId: Map<string, OperatorThreadView>;
  private readonly inbox: OperatorInboxSnapshot;
  readonly viewLookups: string[] = [];

  constructor(input: {
    statuses?: ThreadStatusSnapshot[] | undefined;
    views?: OperatorThreadView[] | undefined;
    inbox?: OperatorInboxSnapshot | undefined;
  }) {
    this.statusesByThreadId = new Map((input.statuses ?? []).map((status) => [status.thread.threadId, status]));
    this.viewsByThreadId = new Map((input.views ?? []).map((view) => [view.thread.threadId, view]));
    this.inbox = input.inbox ?? buildInbox(undefined);
  }

  async getThreadStatus(threadId: string): Promise<ThreadStatusSnapshot | null> {
    return this.statusesByThreadId.get(threadId) ?? null;
  }

  async getOperatorThreadView(threadId: string): Promise<OperatorThreadView | null> {
    this.viewLookups.push(threadId);
    return this.viewsByThreadId.get(threadId) ?? null;
  }

  async listOperatorInbox(): Promise<OperatorInboxSnapshot> {
    return this.inbox;
  }
}

function buildThread(threadId: string, sessionId = threadId): ThreadRecord {
  return {
    threadId,
    sessionId,
    title: threadId,
    status: "WAITING",
    createdAt: "2026-05-24T18:00:00.000Z",
    updatedAt: "2026-05-24T18:00:00.000Z",
  };
}

function buildThreadStatus(thread: ThreadRecord): ThreadStatusSnapshot {
  return {
    thread,
    openRequests: [],
    activeGrants: [],
    contextCheckpoints: [],
    delegations: [],
  };
}

function buildInbox(focusThreadId: string | undefined): OperatorInboxSnapshot {
  return {
    ...(focusThreadId !== undefined ? { focusThreadId } : {}),
    items: [],
    summary: {
      total: 0,
      actionable: 0,
      approvals: 0,
      userInputs: 0,
      checkpoints: 0,
      childBlockers: 0,
      stalled: 0,
      assemblyProposals: 0,
      compatibilityAlerts: 0,
    },
  };
}
