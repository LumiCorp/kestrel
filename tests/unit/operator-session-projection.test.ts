import assert from "node:assert/strict";

import type {
  DelegationRecord,
  OperatorInboxSnapshot,
  OperatorThreadView,
  ThreadRecord,
  ThreadStatusSnapshot,
} from "../../src/orchestration/contracts.js";
import {
  buildOperatorSessionProjection,
  type OperatorSessionProjectionRuntime,
} from "../../src/orchestration/OperatorSessionProjection.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "buildOperatorSessionProjection reads canonical user waits from session state", async () => {
  const runtime = new FakeProjectionRuntime({
    mainThread: buildThread("thread-main", { sessionId: "session-wait" }),
    statuses: [
      buildThreadStatus(buildThread("thread-main", { sessionId: "session-wait" })),
    ],
  });

  const projection = await buildOperatorSessionProjection({
    sessionId: "session-wait",
    session: {
      version: 4,
      currentStepAgent: "act",
      updatedAt: "2026-05-24T12:00:00.000Z",
      state: {
        agent: {
          waitingFor: {
            kind: "user",
            eventType: "user.reply",
            reason: "Need clarification",
            resumeInstruction: "Use the reply as the next instruction.",
            metadata: {
              prompt: "Which file should change?",
            },
          },
        },
      },
    },
    threadRuntime: runtime,
  });

  assert.deepEqual(projection.waitFor, {
    kind: "user",
    eventType: "user.reply",
    metadata: {
      prompt: "Which file should change?",
    },
  });
  assert.equal(projection.threadId, "thread-main");
  assert.equal(projection.focusedThreadId, "thread-main");
});

contractTest("runtime.hermetic", "buildOperatorSessionProjection falls back to the focused thread wait", async () => {
  const thread = buildThread("thread-focused", {
    sessionId: "session-thread-wait",
    waitFor: {
      kind: "approval",
      eventType: "approval.required",
      metadata: {
        approvalId: "approval-1",
      },
    },
  });
  const runtime = new FakeProjectionRuntime({
    mainThread: thread,
    statuses: [buildThreadStatus(thread)],
  });

  const projection = await buildOperatorSessionProjection({
    sessionId: "session-thread-wait",
    session: {
      version: 1,
      state: {},
    },
    threadRuntime: runtime,
  });

  assert.deepEqual(projection.waitFor, {
    kind: "approval",
    eventType: "approval.required",
    metadata: {
      approvalId: "approval-1",
    },
  });
});

contractTest("runtime.hermetic", "buildOperatorSessionProjection synthesizes child blocker waits from operator view", async () => {
  const thread = buildThread("thread-parent", { sessionId: "session-child-blocked" });
  const runtime = new FakeProjectionRuntime({
    mainThread: thread,
    statuses: [buildThreadStatus(thread)],
    views: [
      {
        thread,
        childThreads: [],
        childBlockerChain: [],
        childBlocker: {
          delegationId: "delegation-1",
          childThreadId: "thread-child",
          status: "WAITING",
          reason: "child needs input",
        },
      },
    ],
  });

  const projection = await buildOperatorSessionProjection({
    sessionId: "session-child-blocked",
    session: {
      version: 2,
      state: {},
    },
    threadRuntime: runtime,
  });

  assert.deepEqual(projection.waitFor, {
    kind: "effect",
    eventType: "delegation",
    metadata: {
      delegationId: "delegation-1",
      childThreadId: "thread-child",
    },
  });
  assert.deepEqual(projection.childBlocker, {
    delegationId: "delegation-1",
    childThreadId: "thread-child",
    status: "WAITING",
    reason: "child needs input",
  });
});

contractTest("runtime.hermetic", "buildOperatorSessionProjection returns a minimal projection without a thread runtime", async () => {
  const projection = await buildOperatorSessionProjection({
    sessionId: "session-legacy",
    session: {
      version: 7,
      currentStepAgent: "plan",
      updatedAt: "2026-05-24T13:00:00.000Z",
      state: {},
    },
  });

  assert.deepEqual(projection, {
    sessionId: "session-legacy",
    version: 7,
    currentStepAgent: "plan",
    updatedAt: "2026-05-24T13:00:00.000Z",
  });
});

contractTest("runtime.hermetic", "buildOperatorSessionProjection omits a blank optional updatedAt", async () => {
  for (const updatedAt of ["", "   "]) {
    const projection = await buildOperatorSessionProjection({
      sessionId: "session-legacy-blank-timestamp",
      session: {
        version: 8,
        updatedAt,
        state: {},
      },
    });

    assert.deepEqual(projection, {
      sessionId: "session-legacy-blank-timestamp",
      version: 8,
    });
  }
});

contractTest("runtime.hermetic", "buildOperatorSessionProjection exposes normalized visible todos", async () => {
  const projection = await buildOperatorSessionProjection({
    sessionId: "session-visible-todos",
    session: {
      version: 3,
      state: {
        agent: {
          visibleTodos: {
            objective: "Ship the Desktop polish slice",
            items: [
              {
                id: "todo-1",
                text: "Expose visible todos",
                status: "in_progress",
                note: "Drawer is being wired.",
              },
              {
                id: "todo-2",
                text: "Run focused validation",
                status: "pending",
              },
            ],
          },
        },
      },
    },
  });

  assert.deepEqual(projection.visibleTodos, {
    objective: "Ship the Desktop polish slice",
    items: [
      {
        id: "todo-1",
        text: "Expose visible todos",
        status: "in_progress",
        note: "Drawer is being wired.",
      },
      {
        id: "todo-2",
        text: "Run focused validation",
        status: "pending",
      },
    ],
  });
});

contractTest("runtime.hermetic", "buildOperatorSessionProjection preserves legacy import metadata in fallback main-thread creation", async () => {
  let startedWith: Record<string, unknown> | undefined;
  const thread = buildThread("session-imported");
  const runtime: OperatorSessionProjectionRuntime = {
    getThreadStatus: async () => null,
    listOperatorInbox: async () => buildInbox(thread.threadId),
    getOperatorThreadView: async () => null,
    startThread: async (input) => {
      startedWith = input;
      return thread;
    },
  };

  const projection = await buildOperatorSessionProjection({
    sessionId: "session-imported",
    session: {
      version: 1,
      state: {},
    },
    threadRuntime: runtime,
  });

  assert.equal(projection.threadId, "session-imported");
  assert.deepEqual(startedWith, {
    threadId: "session-imported",
    sessionId: "session-imported",
    title: "session-imported",
    metadata: {
      legacyImported: true,
    },
  });
});

class FakeProjectionRuntime implements OperatorSessionProjectionRuntime {
  private readonly mainThread: ThreadRecord | undefined;
  private readonly statusesByThreadId: Map<string, ThreadStatusSnapshot>;
  private readonly viewsByThreadId: Map<string, OperatorThreadView>;
  private readonly delegationsByThreadId: Map<string, DelegationRecord[]>;
  private readonly inbox: OperatorInboxSnapshot;

  constructor(input: {
    mainThread?: ThreadRecord | undefined;
    statuses?: ThreadStatusSnapshot[] | undefined;
    views?: OperatorThreadView[] | undefined;
    delegations?: DelegationRecord[] | undefined;
    inbox?: OperatorInboxSnapshot | undefined;
  }) {
    this.mainThread = input.mainThread;
    this.statusesByThreadId = new Map((input.statuses ?? []).map((status) => [status.thread.threadId, status]));
    this.viewsByThreadId = new Map((input.views ?? []).map((view) => [view.thread.threadId, view]));
    this.delegationsByThreadId = new Map();
    for (const delegation of input.delegations ?? []) {
      const entries = this.delegationsByThreadId.get(delegation.parentThreadId) ?? [];
      entries.push(delegation);
      this.delegationsByThreadId.set(delegation.parentThreadId, entries);
    }
    this.inbox = input.inbox ?? buildInbox(this.mainThread?.threadId);
  }

  async ensureMainThreadForSession(): Promise<ThreadRecord> {
    if (this.mainThread === undefined) {
      throw new Error("Missing fake main thread");
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
    return this.viewsByThreadId.get(threadId) ?? null;
  }

  async listDelegations(threadId: string): Promise<DelegationRecord[]> {
    return this.delegationsByThreadId.get(threadId) ?? [];
  }
}

function buildThread(
  threadId: string,
  overrides: Partial<ThreadRecord> = {},
): ThreadRecord {
  return {
    threadId,
    sessionId: overrides.sessionId ?? threadId,
    title: overrides.title ?? threadId,
    status: overrides.status ?? "WAITING",
    createdAt: overrides.createdAt ?? "2026-05-24T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-24T10:00:00.000Z",
    ...overrides,
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
