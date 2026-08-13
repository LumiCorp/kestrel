import assert from "node:assert/strict";
import test from "node:test";
import { resolveThreadRuntimeWorkspace } from "./workspace-mode";

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

test("isolated branches start from the parent Thread worktree HEAD", () => {
  assert.deepEqual(resolveThreadRuntimeWorkspace("isolated", "thread-parent"), {
    managedWorktreeRequired: true,
    managedWorktreeIsolation: "scoped",
    managedWorktreeScope: "thread",
    managedWorktreeParentThreadId: "thread-parent",
  });
});

test("legacy Threads preserve the hosted runtime policy", () => {
  assert.equal(resolveThreadRuntimeWorkspace("legacy"), undefined);
});
