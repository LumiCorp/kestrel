import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopProjectThreadWorkspaceBinding,
  createResolvedWorkspaceThreadWorkspaceBinding,
  deriveThreadWorkspaceAuthorityProjection,
  deriveThreadWorkspaceSummaryProjection,
  resolveThreadWorkspaceRuntimeContext,
} from "../../src/workspace/threadWorkspaceBinding.js";

test("desktop project bindings synthesize a minimal runtime workspace context", () => {
  const binding = createDesktopProjectThreadWorkspaceBinding({
    path: "/tmp/project-a",
    label: "project-a",
  });

  assert.deepEqual(deriveThreadWorkspaceSummaryProjection(binding), {
    workspaceId: "/tmp/project-a",
    workspaceLabel: "project-a",
    workspaceRoot: "/tmp/project-a",
  });
  assert.deepEqual(resolveThreadWorkspaceRuntimeContext(binding), {
    workspaceId: "/tmp/project-a",
    workspaceRoot: "/tmp/project-a",
    appRoot: ".",
    commands: {},
    label: "project-a",
  });
});

test("resolved workspace bindings preserve the full runtime context", () => {
  const binding = createResolvedWorkspaceThreadWorkspaceBinding({
    workspaceId: "ws-1",
    workspaceRoot: "/tmp/project-a",
    appRoot: ".",
    commands: {},
    label: "Project A",
  });

  assert.equal(resolveThreadWorkspaceRuntimeContext(binding)?.workspaceId, "ws-1");
  assert.equal(resolveThreadWorkspaceRuntimeContext(binding)?.label, "Project A");
});

test("thread workspace authority projects the submitted local workspace", () => {
  assert.deepEqual(deriveThreadWorkspaceAuthorityProjection({
    threadMetadata: {
      workspace: {
        workspaceId: "workspace-a",
        workspaceRoot: "/tmp/project-a",
        label: "Project A",
      },
    },
  }), {
    kind: "local",
    workspaceId: "workspace-a",
    label: "Project A",
    workspaceRoot: "/tmp/project-a",
    sourceWorkspaceRoot: "/tmp/project-a",
  });
});

test("thread workspace authority prefers the bound managed worktree from session state", () => {
  assert.deepEqual(deriveThreadWorkspaceAuthorityProjection({
    threadMetadata: {
      workspace: {
        workspaceId: "workspace-a",
        workspaceRoot: "/tmp/project-a",
        label: "Project A",
      },
    },
    sessionState: {
      agent: {
        exec: {
          managedWorktreeBinding: {
            status: "bound",
            sourceWorkspaceRoot: "/tmp/project-a",
            sourceRepoRoot: "/tmp/project-a",
            worktreeRoot: "/tmp/managed/project-a",
            baseHead: "base-sha",
            lastObservedSourceHead: "source-sha",
            leaseId: "lease-1",
            leaseKind: "run",
            dirtyState: { dirty: true },
          },
        },
      },
    },
  }), {
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
});
