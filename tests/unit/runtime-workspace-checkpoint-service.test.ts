import assert from "node:assert/strict";
import test from "node:test";

import {
  RuntimeWorkspaceCheckpointService,
  WorkspaceContextResolver,
} from "../../src/workspace/RuntimeWorkspaceServices.js";
import { createEmptyProjectSnapshot } from "../../src/project/state.js";

test("RuntimeWorkspaceCheckpointService resolves project setup before checkpoint capture and diff", async () => {
  const setup = {
    ...createEmptyProjectSnapshot().setup,
    workspaceRoot: "/tmp/runtime-workspace",
    repoRoot: "/tmp/runtime-workspace",
  };
  const calls: Array<{ method: string; setup?: unknown; workspaceRole?: string | undefined }> = [];
  const resolver = new WorkspaceContextResolver({
    getProjectSnapshot: async () => ({
      sessionId: "session-workspace",
      snapshot: {
        ...createEmptyProjectSnapshot(),
        setup,
      },
    }),
  });
  const service = new RuntimeWorkspaceCheckpointService({
    resolver,
    checkpointService: {
      capture: async (input: { setup: unknown; workspaceRole?: string | undefined }) => {
        calls.push({ method: "capture", setup: input.setup, workspaceRole: input.workspaceRole });
        return { checkpoint: { checkpointId: "checkpoint-1" }, files: [] };
      },
      diff: async (input: { setup: unknown }) => {
        calls.push({ method: "diff", setup: input.setup });
        return { files: [] };
      },
    } as never,
  });

  await service.capture({ sessionId: "session-workspace" });
  await service.diff({
    sessionId: "session-workspace",
    source: { workingTree: true },
    target: { checkpointId: "checkpoint-1" },
  });

  assert.deepEqual(calls, [
    { method: "capture", setup, workspaceRole: "source" },
    { method: "diff", setup },
  ]);
});

test("WorkspaceContextResolver fails closed when project setup is missing", async () => {
  const resolver = new WorkspaceContextResolver({
    getProjectSnapshot: async () => ({
      sessionId: "session-missing-workspace",
      snapshot: createEmptyProjectSnapshot(),
    }),
  });

  await assert.rejects(
    () => resolver.resolve({ sessionId: "session-missing-workspace" }),
    (error) => {
      assert.equal((error as { code?: string }).code, "WORKSPACE_CONTEXT_UNAVAILABLE");
      return true;
    },
  );
});
