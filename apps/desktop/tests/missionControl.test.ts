import assert from "node:assert/strict";
import test from "node:test";

import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import { createEmptyProjectSnapshot } from "../../../src/project/state.js";
import {
  getDesktopOperatorRun,
  getDesktopOperatorThread,
  getDesktopProjectSnapshot,
  listDesktopOperatorRuns,
  runDesktopProjectAction,
} from "../src/missionControl.js";

const context: WebRunnerRequestContext = {
  actor: {
    actorId: "desktop-shell",
    actorType: "operator",
  },
};

test("Desktop Mission Control reads authoritative project snapshots through the runner", async () => {
  const calls: unknown[] = [];
  const snapshot = createEmptyProjectSnapshot();
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command, requestContext) {
      calls.push({ command, requestContext });
      return {
        id: "event-1",
        type: "project.snapshot",
        ts: "2026-07-10T12:00:00.000Z",
        payload: { sessionId: "session-1", snapshot },
      };
    },
  };

  const response = await getDesktopProjectSnapshot({
    adapter,
    sessionId: "session-1",
    context,
  });

  assert.deepEqual(response, { sessionId: "session-1", snapshot });
  assert.deepEqual(calls, [{
    command: { type: "project.snapshot.get", sessionId: "session-1" },
    requestContext: context,
  }]);
});

test("Desktop Mission Control validates and forwards task actions", async () => {
  const snapshot = createEmptyProjectSnapshot();
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command, requestContext) {
      calls.push({ command, requestContext });
      return {
        id: "event-2",
        type: "project.snapshot",
        ts: "2026-07-10T12:00:00.000Z",
        payload: { sessionId: "session-1", snapshot },
      };
    },
  };
  const action = {
    type: "task.create",
    sessionId: "session-1",
    actionId: "action-1",
    actionTs: "2026-07-10T12:00:00.000Z",
    title: "Verify Desktop Mission Control",
    instructions: "Read and mutate the authoritative project snapshot.",
  } as const;

  await runDesktopProjectAction({ adapter, action, context });

  assert.deepEqual(calls, [{
    command: { type: "project.action", action },
    requestContext: context,
  }]);
});

test("Desktop Mission Control validates and forwards board actions", async () => {
  const snapshot = createEmptyProjectSnapshot();
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command, requestContext) {
      calls.push({ command, requestContext });
      return {
        id: "event-board",
        type: "project.snapshot",
        ts: "2026-07-10T12:00:00.000Z",
        payload: { sessionId: "session-1", snapshot },
      };
    },
  };
  const action = {
    type: "board.card.create",
    sessionId: "session-1",
    actionId: "action-board",
    actionTs: "2026-07-10T12:00:00.000Z",
    expectedBoardVersion: 1,
    title: "Move Kestrel One",
    prompt: "Promote Kestrel One to the canonical apps/web path.",
    source: "operator",
  } as const;

  await runDesktopProjectAction({ adapter, action, context });

  assert.deepEqual(calls, [{
    command: { type: "project.action", action },
    requestContext: context,
  }]);
});

test("Desktop Mission Control rejects malformed renderer actions before runner use", async () => {
  let called = false;
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl() {
      called = true;
      throw new Error("must not be called");
    },
  };

  await assert.rejects(
    () => runDesktopProjectAction({
      adapter,
      action: {
        type: "task.approve",
        sessionId: "session-1",
      },
      context,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "desktop.invalid_project_action");
      return true;
    },
  );
  assert.equal(called, false);
});

test("Desktop Mission Control projects runtime thread inspection through the runner", async () => {
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command, requestContext) {
      calls.push({ command, requestContext });
      return {
        id: "event-thread",
        type: "operator.thread",
        ts: "2026-07-10T12:00:00.000Z",
        payload: {
          view: {
            thread: {
              threadId: "thread-main:session-1",
              sessionId: "session-1",
              title: "Canonical web cutover",
              status: "RUNNING",
              activeRunId: "run-1",
              agentProfileLabel: "Kestrel build",
              createdAt: "2026-07-10T11:00:00.000Z",
              updatedAt: "2026-07-10T12:00:00.000Z",
            },
            childThreads: [{
              threadId: "thread-child:session-1",
              sessionId: "session-1",
              title: "Verify Desktop bridge",
              status: "WAITING",
              parentThreadId: "thread-main:session-1",
              createdAt: "2026-07-10T11:30:00.000Z",
              updatedAt: "2026-07-10T12:00:00.000Z",
            }],
            childBlockerChain: [],
            workspace: {
              kind: "managed",
              workspaceId: "workspace-a",
              label: "Project A",
              workspaceRoot: "/tmp/managed/project-a",
              sourceWorkspaceRoot: "/tmp/project-a",
              sourceRepoRoot: "/tmp/project-a",
              managedWorktreeRoot: "/tmp/managed/project-a",
              baseHead: "base-sha",
              lastObservedSourceHead: "source-sha",
              leaseId: "lease-1",
              leaseKind: "run",
              dirty: true,
            },
            focusedThreadId: "thread-main:session-1",
            operatorPhase: "act",
            blocker: {
              kind: "checkpoint",
              summary: "Desktop package smoke is required.",
              actionable: true,
              threadId: "thread-main:session-1",
            },
            nextAction: {
              kind: "resolve_context_checkpoint",
              summary: "Run packaged Electron smoke.",
              threadId: "thread-main:session-1",
              checkpointId: "checkpoint-1",
            },
            runtimePlan: {
              phase: "verify",
              status: "running",
              expectedNextCommand: "pnpm desktop:test",
              commandNames: ["pnpm desktop:test"],
            },
          },
        },
      };
    },
  };

  const response = await getDesktopOperatorThread({
    adapter,
    threadId: "thread-main:session-1",
    context,
  });

  assert.equal(response.thread.activeRunId, "run-1");
  assert.equal(response.thread.status, "RUNNING");
  assert.deepEqual(response.workspace, {
    kind: "managed",
    workspaceId: "workspace-a",
    label: "Project A",
    workspaceRoot: "/tmp/managed/project-a",
    sourceWorkspaceRoot: "/tmp/project-a",
    sourceRepoRoot: "/tmp/project-a",
    managedWorktreeRoot: "/tmp/managed/project-a",
    baseHead: "base-sha",
    lastObservedSourceHead: "source-sha",
    leaseId: "lease-1",
    leaseKind: "run",
    dirty: true,
  });
  assert.equal(response.blocker?.summary, "Desktop package smoke is required.");
  assert.equal(response.nextAction?.checkpointId, "checkpoint-1");
  assert.deepEqual(response.runtimePlan?.commandNames, ["pnpm desktop:test"]);
  assert.deepEqual(response.childThreads.map((thread) => thread.threadId), ["thread-child:session-1"]);
  assert.deepEqual(calls, [{
    command: { type: "operator.thread", threadId: "thread-main:session-1" },
    requestContext: context,
  }]);
});

test("Desktop Mission Control rejects malformed runtime thread responses", async () => {
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl() {
      return {
        id: "event-thread-invalid",
        type: "operator.thread",
        ts: "2026-07-10T12:00:00.000Z",
        payload: {
          view: {
            thread: {
              threadId: "thread-main:session-1",
              sessionId: "session-1",
              title: "Broken thread",
              status: "UNKNOWN",
              createdAt: "2026-07-10T11:00:00.000Z",
              updatedAt: "2026-07-10T12:00:00.000Z",
            },
            childThreads: [],
          },
        },
      } as never;
    },
  };

  await assert.rejects(
    () => getDesktopOperatorThread({
      adapter,
      threadId: "thread-main:session-1",
      context,
    }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "desktop.operator_thread_invalid_response",
      );
      return true;
    },
  );
});

test("Desktop Mission Control projects a bounded runtime run and session index", async () => {
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command, requestContext) {
      calls.push({ command, requestContext });
      return {
        id: "event-runs",
        type: "operator.runs",
        ts: "2026-07-10T12:00:03.000Z",
        payload: {
          view: {
            version: "operator-run-index-v1",
            generatedAt: "2026-07-10T12:00:03.000Z",
            filters: { sessionId: "session-1", status: "WAITING", limit: 10 },
            hasMore: false,
            runs: [{
              run: {
                runId: "run-1",
                sessionId: "session-1",
                eventType: "user.message",
                status: "WAITING",
                startedAt: "2026-07-10T12:00:00.000Z",
              },
              threadId: "thread-main:session-1",
              summary: { eventCount: 3, truncated: false },
              diagnosis: {
                status: "WAITING",
                finalStep: "exec.wait_approval",
                actionable: true,
                wait: {
                  kind: "approval",
                  actionable: true,
                  requestId: "request-1",
                },
              },
            }],
            sessions: [{
              sessionId: "session-1",
              runCount: 1,
              statusCounts: { RUNNING: 0, WAITING: 1, COMPLETED: 0, FAILED: 0 },
              latestRunId: "run-1",
              latestStatus: "WAITING",
              latestStartedAt: "2026-07-10T12:00:00.000Z",
            }],
          },
        },
      };
    },
  };

  const response = await listDesktopOperatorRuns({
    adapter,
    query: { sessionId: "session-1", status: "WAITING", limit: 10 },
    context,
  });

  assert.equal(response.version, "operator-run-index-v1");
  assert.equal(response.runs[0]?.run.runId, "run-1");
  assert.equal(response.runs[0]?.diagnosis.wait?.kind, "approval");
  assert.equal(response.sessions[0]?.statusCounts.WAITING, 1);
  assert.deepEqual(calls, [{
    command: {
      type: "operator.runs",
      sessionId: "session-1",
      status: "WAITING",
      limit: 10,
    },
    requestContext: context,
  }]);
});

test("Desktop Mission Control rejects malformed runtime run indexes", async () => {
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl() {
      return {
        id: "event-runs-invalid",
        type: "operator.runs",
        ts: "2026-07-10T12:00:03.000Z",
        payload: {
          view: {
            version: "operator-run-index-v1",
            generatedAt: "2026-07-10T12:00:03.000Z",
            filters: { limit: 51 },
            hasMore: false,
            runs: [],
            sessions: [],
          },
        },
      } as never;
    },
  };

  await assert.rejects(
    () => listDesktopOperatorRuns({ adapter, context }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "desktop.operator_runs_invalid_response",
      );
      return true;
    },
  );
});

test("Desktop Mission Control projects bounded runtime run inspection through the runner", async () => {
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command, requestContext) {
      calls.push({ command, requestContext });
      return {
        id: "event-run",
        type: "operator.run",
        ts: "2026-07-10T12:00:02.000Z",
        runId: "run-1",
        sessionId: "session-1",
        threadId: "thread-main:session-1",
        payload: {
          view: {
            version: "operator-run-v1",
            run: {
              runId: "run-1",
              sessionId: "session-1",
              eventType: "user.message",
              status: "WAITING",
              startedAt: "2026-07-10T12:00:00.000Z",
            },
            threadId: "thread-main:session-1",
            summary: {
              eventCount: 3,
              firstEventAt: "2026-07-10T12:00:00.000Z",
              lastEventAt: "2026-07-10T12:00:02.000Z",
              stepsObserved: 1,
              progressToolCalls: 1,
              waitingMilestones: 1,
              truncated: false,
            },
            diagnosis: {
              status: "WAITING",
              finalStep: "exec.wait_approval",
              actionable: true,
              wait: {
                kind: "approval",
                actionable: true,
                eventType: "operator.approval",
                threadId: "thread-main:session-1",
                requestId: "request-1",
                enteredAt: "2026-07-10T12:00:02.000Z",
              },
              latestReasoning: {
                message: "Package proof requires approval.",
                at: "2026-07-10T12:00:01.000Z",
              },
            },
            modelProvenance: {
              retention: "hash_only",
              callCount: 1,
              actionCallCount: 1,
              maintenanceCallCount: 0,
              providers: ["openai"],
              models: ["gpt-5"],
            },
            runtimePlan: {
              phase: "verify",
              currentChunk: "Packaged smoke",
              status: "waiting",
              expectedNextCommand: "pnpm --filter @kestrel/desktop package",
            },
            timeline: [{
              seq: 1,
              at: "2026-07-10T12:00:00.000Z",
              label: "run started",
              source: "engine",
            }, {
              seq: 2,
              at: "2026-07-10T12:00:02.000Z",
              label: "wait entered",
              detail: "eventType=operator.approval",
              source: "wait",
              step: "exec.wait_approval",
              stepIndex: 4,
            }],
          },
        },
      };
    },
  };

  const response = await getDesktopOperatorRun({
    adapter,
    runId: "run-1",
    context,
  });

  assert.equal(response.run.status, "WAITING");
  assert.equal(response.diagnosis.wait?.requestId, "request-1");
  assert.equal(response.modelProvenance.callCount, 1);
  assert.equal(response.timeline[1]?.source, "wait");
  assert.deepEqual(calls, [{
    command: { type: "operator.run", runId: "run-1" },
    requestContext: context,
  }]);
});

test("Desktop Mission Control rejects malformed runtime run responses", async () => {
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl() {
      return {
        id: "event-run-invalid",
        type: "operator.run",
        ts: "2026-07-10T12:00:00.000Z",
        payload: {
          view: {
            version: "operator-run-v1",
            run: {
              runId: "run-1",
              sessionId: "session-1",
              eventType: "user.message",
              status: "WAITING",
              startedAt: "2026-07-10T12:00:00.000Z",
            },
            summary: {
              eventCount: 1,
              stepsObserved: 0,
              progressToolCalls: 0,
              waitingMilestones: 0,
              truncated: false,
            },
            diagnosis: {
              status: "WAITING",
              actionable: false,
            },
            modelProvenance: {
              retention: "hash_only",
              callCount: 0,
              actionCallCount: 0,
              maintenanceCallCount: 0,
              providers: [],
              models: [],
            },
            timeline: [{
              seq: 0,
              at: "not-a-timestamp",
              label: "broken",
              source: "unknown",
            }],
          },
        },
      } as never;
    },
  };

  await assert.rejects(
    () => getDesktopOperatorRun({ adapter, runId: "run-1", context }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "desktop.operator_run_invalid_response",
      );
      return true;
    },
  );
});
