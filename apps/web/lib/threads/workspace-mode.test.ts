import assert from "node:assert/strict";
import test from "node:test";
import {
  NEW_THREAD_WORKSPACE_MODES,
  resolveThreadRuntimeWorkspace,
} from "./workspace-mode";

test("new Thread boundaries expose only primary and isolated modes", () => {
  assert.deepEqual(NEW_THREAD_WORKSPACE_MODES, ["primary", "isolated"]);
});

test("primary Threads select the shared Workspace checkout", () => {
  assert.deepEqual(resolveThreadRuntimeWorkspace("primary"), {
    managedWorktreeRequired: false,
    managedWorktreeScope: "thread",
  });
});

test("isolated Threads select a stable scoped worktree", () => {
  assert.deepEqual(resolveThreadRuntimeWorkspace("isolated"), {
    managedWorktreeRequired: true,
    managedWorktreeIsolation: "scoped",
    managedWorktreeScope: "thread",
  });
});

test("isolated branches carry their creation-time parent HEAD", () => {
  assert.deepEqual(
    resolveThreadRuntimeWorkspace(
      "isolated",
      "thread-parent",
      "a".repeat(40),
    ),
    {
    managedWorktreeRequired: true,
    managedWorktreeIsolation: "scoped",
    managedWorktreeScope: "thread",
    managedWorktreeBaseRef: "a".repeat(40),
    managedWorktreeParentThreadId: "thread-parent",
    },
  );
});

test("legacy Threads preserve the hosted runtime policy", () => {
  assert.equal(resolveThreadRuntimeWorkspace("legacy"), undefined);
});
