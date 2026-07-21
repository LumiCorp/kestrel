import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopRuntimeThreadInspection } from "../src/contracts.js";
import { resolveDesktopWorkspaceAccessRoot } from "../src/workspaceAccess.js";

test("registered source roots remain available without runtime lookup", async () => {
  let lookedUp = false;
  const root = await resolveDesktopWorkspaceAccessRoot({
    rootPath: "/tmp/project-a",
    registeredRootPaths: ["/tmp/project-a"],
    getOperatorThread: async () => {
      lookedUp = true;
      return inspection();
    },
  });

  assert.equal(root, "/tmp/project-a");
  assert.equal(lookedUp, false);
});

test("managed worktree roots require and accept Local Core thread authority", async () => {
  const root = await resolveDesktopWorkspaceAccessRoot({
    rootPath: "/tmp/managed/project-a",
    registeredRootPaths: ["/tmp/project-a"],
    threadId: "thread-1",
    getOperatorThread: async (threadId) => {
      assert.equal(threadId, "thread-1");
      return inspection();
    },
  });

  assert.equal(root, "/tmp/managed/project-a");
});

test("thread scope cannot authorize a different managed worktree", async () => {
  await assert.rejects(
    resolveDesktopWorkspaceAccessRoot({
      rootPath: "/tmp/managed/forged",
      registeredRootPaths: ["/tmp/project-a"],
      threadId: "thread-1",
      getOperatorThread: async () => inspection(),
    }),
    {
      name: "DesktopError",
      code: "desktop.thread_workspace_mismatch",
    },
  );
});

test("unregistered roots remain denied without thread authority", async () => {
  await assert.rejects(
    resolveDesktopWorkspaceAccessRoot({
      rootPath: "/tmp/managed/project-a",
      registeredRootPaths: ["/tmp/project-a"],
      getOperatorThread: async () => inspection(),
    }),
    {
      name: "DesktopError",
      code: "desktop.unregistered_project_root",
    },
  );
});

function inspection(): DesktopRuntimeThreadInspection {
  return {
    thread: {
      threadId: "thread-1",
      sessionId: "session-1",
      title: "Managed worktree",
      status: "IDLE",
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
    },
    workspace: {
      kind: "managed",
      workspaceId: "workspace-a",
      label: "Project A",
      workspaceRoot: "/tmp/managed/project-a",
      sourceWorkspaceRoot: "/tmp/project-a",
      managedWorktreeRoot: "/tmp/managed/project-a",
    },
    childThreads: [],
  };
}
