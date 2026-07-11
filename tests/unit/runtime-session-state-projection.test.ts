import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadRecord } from "../../src/kestrel/contracts/orchestration.js";
import type { SessionRecord } from "../../src/kestrel/contracts/store.js";

import type { ProductTaskGraph } from "../../src/taskGraph/contracts.js";
import type {
  OperatorInboxSnapshot,
  OperatorThreadView,
  ThreadStatusSnapshot,
} from "../../src/orchestration/contracts.js";
import {
  buildRuntimeSessionStateProjection,
  type OperatorSessionProjectionRuntime,
} from "../../src/orchestration/index.js";

test("buildRuntimeSessionStateProjection composes session projection and task graph context", async () => {
  const thread = buildThread("thread-main", "session-state");
  const status = buildThreadStatus(thread);
  const inbox = buildInbox(thread.threadId);
  const operatorView: OperatorThreadView = {
    thread,
    childThreads: [],
    childBlockerChain: [],
    nextAction: {
      kind: "wait",
      summary: "Wait for operator",
    },
  };
  const runtime = new FakeProjectionRuntime({
    mainThread: thread,
    statuses: [status],
    inbox,
    views: [operatorView],
  });
  const renderedGraph: ProductTaskGraph = {
    version: 1,
    rootTaskIds: ["task-main"],
    tasks: {},
  };
  let graphInput:
    | {
        sessionId: string;
        session: SessionRecord | null;
        thread?: ThreadRecord | undefined;
        operatorView?: OperatorThreadView | undefined;
        operatorInbox?: OperatorInboxSnapshot | undefined;
      }
    | undefined;

  const projection = await buildRuntimeSessionStateProjection({
    sessionId: "session-state",
    session: {
      sessionId: "session-state",
      version: 3,
      updatedAt: "2026-05-24T16:00:00.000Z",
      state: {},
    },
    threadRuntime: runtime,
    taskGraphStore: {
      renderGraphFromSession: (input) => {
        graphInput = input;
        return renderedGraph;
      },
    },
  });

  assert.equal(projection.session.threadId, "thread-main");
  assert.equal(projection.session.nextAction, "Wait for operator");
  assert.equal(projection.version, 3);
  assert.equal(projection.graph, renderedGraph);
  assert.equal(graphInput?.sessionId, "session-state");
  assert.equal(graphInput?.thread?.threadId, "thread-main");
  assert.equal(graphInput?.operatorView, operatorView);
  assert.equal(graphInput?.operatorInbox, inbox);
  assert.deepEqual(runtime.viewLookups, ["thread-main"]);
});

test("buildRuntimeSessionStateProjection renders task graph with main thread view when focus is on a child", async () => {
  const mainThread = buildThread("thread-main", "session-focused");
  const childThread = buildThread("thread-child", "session-child");
  const mainView: OperatorThreadView = {
    thread: mainThread,
    childThreads: [],
    childBlockerChain: [],
    nextAction: {
      kind: "reply",
      summary: "Continue main thread",
    },
  };
  const childView: OperatorThreadView = {
    thread: childThread,
    childThreads: [],
    childBlockerChain: [],
    nextAction: {
      kind: "reply",
      summary: "Reply to child",
    },
  };
  const runtime = new FakeProjectionRuntime({
    mainThread,
    statuses: [buildThreadStatus(mainThread), buildThreadStatus(childThread)],
    inbox: buildInbox(childThread.threadId),
    views: [mainView, childView],
  });
  let graphInput:
    | {
        thread?: ThreadRecord | undefined;
        operatorView?: OperatorThreadView | undefined;
      }
    | undefined;

  const projection = await buildRuntimeSessionStateProjection({
    sessionId: "session-focused",
    session: {
      sessionId: "session-focused",
      version: 4,
      updatedAt: "2026-05-24T16:05:00.000Z",
      state: {},
    },
    threadRuntime: runtime,
    taskGraphStore: {
      renderGraphFromSession: (input) => {
        graphInput = input;
        return {
          version: 1,
          rootTaskIds: [],
          tasks: {},
        };
      },
    },
  });

  assert.equal(projection.session.focusedThreadId, childThread.threadId);
  assert.equal(projection.session.operatorThreadView, childView);
  assert.equal(graphInput?.thread?.threadId, mainThread.threadId);
  assert.equal(graphInput?.operatorView, mainView);
  assert.deepEqual(runtime.viewLookups, [childThread.threadId, mainThread.threadId]);
});

test("buildRuntimeSessionStateProjection returns an empty graph without a task graph store", async () => {
  const projection = await buildRuntimeSessionStateProjection({
    sessionId: "session-minimal",
    session: {
      sessionId: "session-minimal",
      version: 1,
      updatedAt: "2026-05-24T16:10:00.000Z",
      state: {},
    },
  });

  assert.deepEqual(projection.graph, {
    version: 1,
    rootTaskIds: [],
    tasks: {},
  });
});

class FakeProjectionRuntime implements OperatorSessionProjectionRuntime {
  private readonly mainThread: ThreadRecord | undefined;
  private readonly statusesByThreadId: Map<string, ThreadStatusSnapshot>;
  private readonly viewsByThreadId: Map<string, OperatorThreadView>;
  private readonly inbox: OperatorInboxSnapshot;
  readonly viewLookups: string[] = [];

  constructor(input: {
    mainThread?: ThreadRecord | undefined;
    statuses?: ThreadStatusSnapshot[] | undefined;
    views?: OperatorThreadView[] | undefined;
    inbox?: OperatorInboxSnapshot | undefined;
  }) {
    this.mainThread = input.mainThread;
    this.statusesByThreadId = new Map((input.statuses ?? []).map((status) => [status.thread.threadId, status]));
    this.viewsByThreadId = new Map((input.views ?? []).map((view) => [view.thread.threadId, view]));
    this.inbox = input.inbox ?? buildInbox(this.mainThread?.threadId);
  }

  async ensureMainThreadForSession(): Promise<ThreadRecord> {
    if (this.mainThread === undefined) {
      throw new Error("mainThread is required");
    }
    return this.mainThread;
  }

  async getThreadStatus(threadId: string): Promise<ThreadStatusSnapshot | null> {
    return this.statusesByThreadId.get(threadId) ?? null;
  }

  async listOperatorInbox(): Promise<OperatorInboxSnapshot> {
    return this.inbox;
  }

  async getOperatorThreadView(threadId: string): Promise<OperatorThreadView | null> {
    this.viewLookups.push(threadId);
    return this.viewsByThreadId.get(threadId) ?? null;
  }
}

function buildThread(threadId: string, sessionId = threadId): ThreadRecord {
  return {
    threadId,
    sessionId,
    title: threadId,
    status: "WAITING",
    createdAt: "2026-05-24T16:00:00.000Z",
    updatedAt: "2026-05-24T16:00:00.000Z",
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
