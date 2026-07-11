import assert from "node:assert/strict";
import test from "node:test";

import type { SessionRecord, SessionStore } from "../src/kestrel/contracts/store.js";

import { InMemorySessionStore } from "../src/store/InMemorySessionStore.js";
import { ProductTaskGraphStore } from "../src/taskGraph/store.js";

class RejectOncePatchSessionStore extends InMemorySessionStore {
  failNextPatch = false;
  patchCalls = 0;

  override async patchSessionState(input: {
    sessionId: string;
    statePatch: Record<string, unknown>;
    expectedVersion?: number | undefined;
    nextStepAgent?: string | undefined;
    reason?: string | undefined;
  }): Promise<SessionRecord> {
    this.patchCalls += 1;
    if (this.failNextPatch) {
      this.failNextPatch = false;
      throw new Error("patch failed");
    }
    return super.patchSessionState(input);
  }
}

test("ProductTaskGraphStore seeds runtime-backed graph from thread context", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await store.ensureSession("session-main");

  const graph = await graphStore.getGraph({
    sessionId: "session-main",
    thread: {
      threadId: "thread-main",
      sessionId: "session-main",
      title: "Main thread",
      status: "WAITING",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    operatorInbox: {
      focusThreadId: "thread-main",
      items: [],
      summary: {
        total: 1,
        actionable: 1,
        approvals: 1,
        userInputs: 0,
        checkpoints: 0,
        childBlockers: 0,
        stalled: 0,
        assemblyProposals: 0,
        compatibilityAlerts: 0,
      },
    },
    operatorView: {
      thread: {
        threadId: "thread-main",
        sessionId: "session-main",
        title: "Main thread",
        status: "WAITING",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      childThreads: [],
      childBlockerChain: [],
      nextAction: {
        kind: "approve",
        summary: "approve tool action",
      },
      latestCheckpoint: {
        checkpointId: "checkpoint-1",
        threadId: "thread-main",
        createdAt: new Date().toISOString(),
        status: "PENDING",
        recommendedAction: "continue",
        reason: "Needs review",
      },
    },
  });

  const task = graph.tasks["task:thread:thread-main"];
  assert.ok(task);
  assert.equal(task.status, "waiting");
  assert.equal(task.runtime.nextAction, "approve tool action");
});

test("ProductTaskGraphStore persists task memory and active task state", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await store.ensureSession("session-main");

  const saved = await graphStore.saveGraph({
    sessionId: "session-main",
    graph: {
      version: 1,
      activeTaskId: "task:thread:thread-main",
      rootTaskIds: ["task:thread:thread-main"],
      tasks: {
        "task:thread:thread-main": {
          id: "task:thread:thread-main",
          title: "Main thread",
          order: 0,
          status: "active",
          source: "thread",
          proposedByAgent: false,
          linkedThreadId: "thread-main",
          linkedSessionId: "session-main",
          activeThreadLineageId: "thread-main",
          memory: {
            goal: "Ship the cockpit",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "Persist the task graph",
            linkedArtifacts: ["README.md"],
          },
          runtime: {},
          updatedAt: new Date().toISOString(),
        },
      },
    },
  });

  assert.equal(saved.graph.activeTaskId, "task:thread:thread-main");
  const session = await store.getSession("session-main");
  assert.equal(
    (((session?.state.product as { taskGraph?: { tasks?: Record<string, { memory?: { goal?: string } }> } })?.taskGraph
      ?.tasks?.["task:thread:thread-main"]?.memory?.goal) ?? ""),
    "Ship the cockpit",
  );
});

test("ProductTaskGraphStore applies delegation updates into persisted state", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await graphStore.saveGraph({
    sessionId: "session-main",
    graph: {
      version: 1,
      activeTaskId: "task:thread:thread-main",
      rootTaskIds: ["task:thread:thread-main"],
      tasks: {
        "task:thread:thread-main": {
          id: "task:thread:thread-main",
          title: "Main thread",
          order: 0,
          status: "active",
          source: "thread",
          proposedByAgent: false,
          linkedThreadId: "thread-main",
          linkedSessionId: "session-main",
          activeThreadLineageId: "thread-main",
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {},
          updatedAt: new Date().toISOString(),
        },
      },
    },
  });

  const updated = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    task: {
      taskId: "task-child",
      title: "Investigate browser flow",
      status: "WAITING",
      childSessionId: "session-child",
      waitEventType: "user.approval",
      updatedAt: new Date().toISOString(),
    },
  });

  assert.equal(updated.tasks["task-child"]?.parentTaskId, "task:thread:thread-main");
  assert.equal(updated.tasks["task-child"]?.status, "waiting");
});

test("ProductTaskGraphStore aggregates child agent activity on active task by default", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await graphStore.saveGraph({
    sessionId: "session-main",
    graph: {
      version: 1,
      activeTaskId: "task:thread:thread-main",
      rootTaskIds: ["task:thread:thread-main"],
      tasks: {
        "task:thread:thread-main": {
          id: "task:thread:thread-main",
          title: "Main thread",
          order: 0,
          status: "active",
          source: "thread",
          proposedByAgent: false,
          linkedThreadId: "thread-main",
          linkedSessionId: "session-main",
          activeThreadLineageId: "thread-main",
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {
            nextAction: "Keep parent task context",
          },
          updatedAt: new Date().toISOString(),
        },
      },
    },
  });

  const running = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task:thread:thread-main",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Investigate browser flow",
      status: "RUNNING",
      childSessionId: "session-child",
      updatedAt: "2026-05-18T12:00:00.000Z",
    },
  });

  assert.equal(running.tasks["task-child"], undefined);
  assert.equal(running.tasks["task:thread:thread-main"]?.runtime.nextAction, "Keep parent task context");
  assert.deepEqual(running.tasks["task:thread:thread-main"]?.runtime.childActivity, {
    total: 1,
    active: 1,
    blocked: 0,
    failed: 0,
    completed: 0,
  });
  assert.equal(
    running.tasks["task:thread:thread-main"]?.runtime.childSummary,
    "children:1 active:1 blocked:0 failed:0 completed:0",
  );

  const completed = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task:thread:thread-main",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Investigate browser flow",
      status: "COMPLETED",
      childSessionId: "session-child",
      resultSummary: "Browser flow verified",
      updatedAt: "2026-05-18T12:01:00.000Z",
    },
  });

  assert.deepEqual(completed.tasks["task:thread:thread-main"]?.runtime.childActivity, {
    total: 1,
    active: 0,
    blocked: 0,
    failed: 0,
    completed: 1,
    latestResult: "Browser flow verified",
  });
  assert.equal(
    completed.tasks["task:thread:thread-main"]?.runtime.childSummary,
    "children:1 active:0 blocked:0 failed:0 completed:1",
  );
  assert.equal(completed.tasks["task:thread:thread-main"]?.runtime.resultSummary, "Browser flow verified");

  const reloaded = await graphStore.getGraph({ sessionId: "session-main" });
  assert.deepEqual(reloaded.tasks["task:thread:thread-main"]?.runtime.childActivity, {
    total: 1,
    active: 0,
    blocked: 0,
    failed: 0,
    completed: 1,
    latestResult: "Browser flow verified",
  });
});

test("ProductTaskGraphStore moves repeated child updates between aggregate buckets", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await graphStore.saveGraph({
    sessionId: "session-main",
    graph: {
      version: 1,
      activeTaskId: "task-parent",
      rootTaskIds: ["task-parent"],
      tasks: {
        "task-parent": {
          id: "task-parent",
          title: "Parent task",
          order: 0,
          status: "active",
          source: "manual",
          proposedByAgent: false,
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {},
          updatedAt: new Date().toISOString(),
        },
      },
    },
  });

  await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Child task",
      status: "WAITING",
      childSessionId: "session-child",
      updatedAt: "2026-05-18T12:00:00.000Z",
    },
  });
  const failed = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Child task",
      status: "FAILED",
      childSessionId: "session-child",
      resultSummary: "Timed out",
      updatedAt: "2026-05-18T12:01:00.000Z",
    },
  });

  assert.deepEqual(failed.tasks["task-parent"]?.runtime.childActivity, {
    total: 1,
    active: 0,
    blocked: 0,
    failed: 1,
    completed: 0,
    latestResult: "Timed out",
  });
  assert.equal(
    failed.tasks["task-parent"]?.runtime.childSummary,
    "children:1 active:0 blocked:0 failed:1 completed:0",
  );
});

test("ProductTaskGraphStore ignores stale aggregate child updates", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await graphStore.saveGraph({
    sessionId: "session-main",
    graph: {
      version: 1,
      activeTaskId: "task-parent",
      rootTaskIds: ["task-parent"],
      tasks: {
        "task-parent": {
          id: "task-parent",
          title: "Parent task",
          order: 0,
          status: "active",
          source: "manual",
          proposedByAgent: false,
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {},
          updatedAt: "2026-05-18T12:00:00.000Z",
        },
      },
    },
  });

  await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Child task",
      status: "COMPLETED",
      childSessionId: "session-child",
      resultSummary: "Done",
      updatedAt: "2026-05-18T12:02:00.000Z",
    },
  });
  const stale = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Child task",
      status: "RUNNING",
      childSessionId: "session-child",
      updatedAt: "2026-05-18T12:01:00.000Z",
    },
  });

  assert.deepEqual(stale.tasks["task-parent"]?.runtime.childActivity, {
    total: 1,
    active: 0,
    blocked: 0,
    failed: 0,
    completed: 1,
    latestResult: "Done",
  });
  assert.equal(
    stale.tasks["task-parent"]?.runtime.childSummary,
    "children:1 active:0 blocked:0 failed:0 completed:1",
  );
});

test("ProductTaskGraphStore replaces stale aggregate result fields on later child updates", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await graphStore.saveGraph({
    sessionId: "session-main",
    graph: {
      version: 1,
      activeTaskId: "task-parent",
      rootTaskIds: ["task-parent"],
      tasks: {
        "task-parent": {
          id: "task-parent",
          title: "Parent task",
          order: 0,
          status: "active",
          source: "manual",
          proposedByAgent: false,
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {},
          updatedAt: "2026-05-18T12:00:00.000Z",
        },
      },
    },
  });

  await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Child task",
      status: "WAITING",
      childSessionId: "session-child",
      waitEventType: "user.reply",
      result: {
        status: "blocked",
        result: "Waiting for user input",
        error: { code: "user.reply", message: "Need a reply" },
        references: ["file:///tmp/waiting.md"],
      },
      errorCode: "user.reply",
      references: ["file:///tmp/waiting.md"],
      updatedAt: "2026-05-18T12:01:00.000Z",
    },
  });
  const completed = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Child task",
      status: "COMPLETED",
      childSessionId: "session-child",
      result: {
        status: "completed",
        result: "Done",
      },
      resultSummary: "Done",
      updatedAt: "2026-05-18T12:02:00.000Z",
    },
  });

  const runtime = completed.tasks["task-parent"]?.runtime;
  assert.equal(runtime?.resultStatus, "completed");
  assert.equal(runtime?.resultSummary, "Done");
  assert.equal(runtime?.errorCode, undefined);
  assert.equal(runtime?.references, undefined);
  assert.equal(runtime?.blocker, undefined);
});

test("ProductTaskGraphStore preserves aggregate result fields across unrelated child updates", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await graphStore.saveGraph({
    sessionId: "session-main",
    graph: {
      version: 1,
      activeTaskId: "task-parent",
      rootTaskIds: ["task-parent"],
      tasks: {
        "task-parent": {
          id: "task-parent",
          title: "Parent task",
          order: 0,
          status: "active",
          source: "manual",
          proposedByAgent: false,
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {},
          updatedAt: "2026-05-18T12:00:00.000Z",
        },
      },
    },
  });

  await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child-a",
      title: "Child A",
      status: "COMPLETED",
      childSessionId: "session-child-a",
      result: {
        status: "completed",
        result: "Child A done",
      },
      resultSummary: "Child A done",
      updatedAt: "2026-05-18T12:01:00.000Z",
    },
  });
  const running = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child-b",
      title: "Child B",
      status: "RUNNING",
      childSessionId: "session-child-b",
      updatedAt: "2026-05-18T12:02:00.000Z",
    },
  });

  const runtime = running.tasks["task-parent"]?.runtime;
  assert.equal(runtime?.resultStatus, "completed");
  assert.equal(runtime?.resultSummary, "Child A done");
  assert.equal(runtime?.resultDelegationTaskId, "task-child-a");
  assert.deepEqual(runtime?.childActivity, {
    total: 2,
    active: 1,
    blocked: 0,
    failed: 0,
    completed: 1,
    latestResult: "Child A done",
  });
});

test("ProductTaskGraphStore preserves existing child task cards when aggregate mode is enabled", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await graphStore.saveGraph({
    sessionId: "session-main",
    graph: {
      version: 1,
      activeTaskId: "task-parent",
      rootTaskIds: ["task-parent"],
      tasks: {
        "task-parent": {
          id: "task-parent",
          title: "Parent task",
          order: 0,
          status: "active",
          source: "manual",
          proposedByAgent: false,
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {},
          updatedAt: "2026-05-18T12:00:00.000Z",
        },
        "task-child": {
          id: "task-child",
          title: "Existing child card",
          order: 0,
          status: "active",
          source: "delegation",
          proposedByAgent: true,
          parentTaskId: "task-parent",
          linkedSessionId: "session-child",
          childSessionId: "session-child",
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {},
          updatedAt: "2026-05-18T12:00:00.000Z",
        },
      },
    },
  });

  const updated = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Updated child card",
      status: "COMPLETED",
      childSessionId: "session-child",
      resultSummary: "Child card done",
      updatedAt: "2026-05-18T12:01:00.000Z",
    },
  });

  assert.equal(updated.tasks["task-child"]?.status, "done");
  assert.equal(updated.tasks["task-child"]?.runtime.resultSummary, "Child card done");
  assert.equal(updated.tasks["task-parent"]?.runtime.childActivity, undefined);
});

test("ProductTaskGraphStore ignores stale updates for existing child task cards", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await graphStore.saveGraph({
    sessionId: "session-main",
    graph: {
      version: 1,
      activeTaskId: "task-parent",
      rootTaskIds: ["task-parent"],
      tasks: {
        "task-parent": {
          id: "task-parent",
          title: "Parent task",
          order: 0,
          status: "active",
          source: "manual",
          proposedByAgent: false,
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {},
          updatedAt: "2026-05-18T12:00:00.000Z",
        },
        "task-child": {
          id: "task-child",
          title: "Existing child card",
          order: 0,
          status: "done",
          source: "delegation",
          proposedByAgent: true,
          parentTaskId: "task-parent",
          linkedSessionId: "session-child",
          childSessionId: "session-child",
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {
            resultSummary: "Already done",
          },
          updatedAt: "2026-05-18T12:02:00.000Z",
        },
      },
    },
  });

  const updated = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Stale child card update",
      status: "RUNNING",
      childSessionId: "session-child",
      updatedAt: "2026-05-18T12:01:00.000Z",
    },
  });

  assert.equal(updated.tasks["task-child"]?.status, "done");
  assert.equal(updated.tasks["task-child"]?.runtime.resultSummary, "Already done");
  assert.equal(updated.tasks["task-child"]?.updatedAt, "2026-05-18T12:02:00.000Z");
  assert.equal((await store.getSession("session-main"))?.version, 1);
});

test("ProductTaskGraphStore continues queued mutations after a rejected patch", async () => {
  const store = new RejectOncePatchSessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    store.failNextPatch = true;
    await assert.rejects(
      graphStore.applyDelegationUpdate({
        sessionId: "session-main",
        task: {
          taskId: "task-child-failed",
          title: "Failed child task",
          status: "RUNNING",
          childSessionId: "session-child-failed",
          updatedAt: "2026-05-18T12:00:00.000Z",
        },
      }),
      /patch failed/,
    );

    const updated = await graphStore.applyDelegationUpdate({
      sessionId: "session-main",
      task: {
        taskId: "task-child-next",
        title: "Next child task",
        status: "RUNNING",
        childSessionId: "session-child-next",
        updatedAt: "2026-05-18T12:01:00.000Z",
      },
    });

    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    assert.equal(updated.tasks["task-child-next"]?.status, "active");
    assert.equal(store.patchCalls, 2);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("ProductTaskGraphStore falls back to delegation task when aggregate parent is missing", async () => {
  const store = new InMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await store.ensureSession("session-main");

  const updated = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-missing",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Child task",
      status: "RUNNING",
      childSessionId: "session-child",
      updatedAt: "2026-05-18T12:00:00.000Z",
    },
  });

  assert.equal(updated.tasks["task-child"]?.parentTaskId, undefined);
  assert.equal(updated.tasks["task-child"]?.status, "active");
  assert.deepEqual(updated.rootTaskIds, ["task-child"]);
});

test("ProductTaskGraphStore aggregates in no-patch fallback path", async () => {
  const session = {
    sessionId: "session-main",
    version: 1,
    state: {
      product: {
        taskGraph: {
          version: 1,
          activeTaskId: "task-parent",
          rootTaskIds: ["task-parent"],
          tasks: {
            "task-parent": {
              id: "task-parent",
              title: "Parent task",
              order: 0,
              status: "active",
              source: "manual",
              proposedByAgent: false,
              memory: {
                goal: "",
                currentPlan: "",
                findings: "",
                decisions: "",
                openQuestions: "",
                nextAction: "",
                linkedArtifacts: [],
              },
              runtime: {},
              updatedAt: "2026-05-18T12:00:00.000Z",
            },
          },
        },
      },
    },
    currentStepAgent: undefined,
    updatedAt: "2026-05-18T12:00:00.000Z",
  };
  const graphStore = new ProductTaskGraphStore({
    getSession: async () => session,
    ensureSession: async () => session,
  } as unknown as SessionStore);

  const updated = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Child task",
      status: "RUNNING",
      childSessionId: "session-child",
      updatedAt: "2026-05-18T12:01:00.000Z",
    },
  });

  assert.equal(updated.tasks["task-child"], undefined);
  assert.deepEqual(updated.tasks["task-parent"]?.runtime.childActivity, {
    total: 1,
    active: 1,
    blocked: 0,
    failed: 0,
    completed: 0,
  });
});
