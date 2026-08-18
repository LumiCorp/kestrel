import test from "node:test";
import assert from "node:assert/strict";

import { inspectDesktopThreadAuthority } from "../src/threadAuthority.js";
import {
  isDesktopThreadWorking,
  reconcileDesktopThreadAuthority,
} from "../renderer/src/threadAuthorityState.js";
import type { DesktopRuntimeThreadInspection } from "../src/contracts.js";

const view = {
  thread: {
    threadId: "thread-main:session-1",
    sessionId: "session-1",
    title: "Thread",
    status: "RUNNING" as const,
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
  },
  workspace: {
    kind: "managed" as const,
    label: "Project",
    workspaceRoot: "/worktree/project",
    sourceWorkspaceRoot: "/source/project",
  },
  childThreads: [],
  activeRun: { runId: "run-1", status: "RUNNING" as const },
  followUpQueue: { state: "ready" as const, items: [] },
  inboxItems: [],
} satisfies DesktopRuntimeThreadInspection;

test("thread authority normalizes expected missing threads without hiding other failures", async () => {
  const missing = Object.assign(new Error("missing"), { code: "OPERATOR_THREAD_NOT_FOUND" });
  assert.deepEqual(await inspectDesktopThreadAuthority({ inspect: async () => { throw missing; } }), { status: "missing" });
  const unavailable = Object.assign(new Error("offline"), { code: "RUNNER_UNAVAILABLE" });
  await assert.rejects(inspectDesktopThreadAuthority({ inspect: async () => { throw unavailable; } }), (error) => error === unavailable);
  assert.deepEqual(await inspectDesktopThreadAuthority({ inspect: async () => view }), { status: "available", view });
});

test("authority reconciliation owns view run and workspace caches together", () => {
  const available = reconcileDesktopThreadAuthority({
    caches: { threadViews: {}, activeRuns: {}, threadWorkspaces: {}, authorityStatuses: {} },
    rendererThreadId: "renderer-1",
    sessionId: "session-1",
    result: { status: "available", view },
  });
  assert.equal(available.threadViews["renderer-1"], view);
  assert.equal(available.activeRuns["renderer-1"]?.runId, "run-1");
  assert.equal(available.threadWorkspaces["session-1"]?.workspaceRoot, "/worktree/project");
  assert.equal(available.authorityStatuses["renderer-1"], "available");

  const missing = reconcileDesktopThreadAuthority({
    caches: available,
    rendererThreadId: "renderer-1",
    sessionId: "session-1",
    result: { status: "missing" },
  });
  assert.deepEqual(missing, {
    threadViews: {},
    activeRuns: {},
    threadWorkspaces: {},
    authorityStatuses: { "renderer-1": "missing" },
  });
});

test("working state excludes a turn that is waiting for the operator", () => {
  const waiting = reconcileDesktopThreadAuthority({
    caches: { threadViews: {}, activeRuns: {}, threadWorkspaces: {}, authorityStatuses: {} },
    rendererThreadId: "renderer-1",
    sessionId: "session-1",
    result: {
      status: "available",
      view: {
        ...view,
        thread: { ...view.thread, status: "WAITING" },
        activeRun: { runId: "run-1", status: "WAITING" },
      },
    },
  });

  assert.equal(isDesktopThreadWorking(waiting, "renderer-1"), false);
  assert.equal(isDesktopThreadWorking({
    ...waiting,
    threadViews: {
      "renderer-1": {
        ...waiting.threadViews["renderer-1"]!,
        thread: { ...waiting.threadViews["renderer-1"]!.thread, status: "RUNNING" },
        activeRun: undefined,
      },
    },
  }, "renderer-1"), true);
  assert.equal(isDesktopThreadWorking({
    ...waiting,
    activeRuns: { "renderer-1": { threadId: "renderer-1", sessionId: "session-1", runId: "run-2" } },
  }, "renderer-1"), true);
});
