import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopProjectThreadWorkspaceBinding,
  createResolvedWorkspaceThreadWorkspaceBinding,
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
