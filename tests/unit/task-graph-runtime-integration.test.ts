import assert from "node:assert/strict";
import test from "node:test";

import {
  applyActiveTaskRuntimeMetadata,
  persistDelegationTaskUpdateToGraph,
} from "../../src/taskGraph/runtimeIntegration.js";
import type { DelegationTaskUpdate } from "../../src/orchestration/DelegationSupervisor.js";

test("applyActiveTaskRuntimeMetadata injects active task id from task graph", async () => {
  const input = {
    sessionId: "session-1",
    message: "continue",
    metadata: {
      existing: true,
    },
  };

  const output = await applyActiveTaskRuntimeMetadata(input, {
    async getGraph() {
      return {
        activeTaskId: "task-active",
      };
    },
  });

  assert.deepEqual(output.metadata, {
    existing: true,
    activeTaskId: "task-active",
  });
});

test("applyActiveTaskRuntimeMetadata preserves explicit active task metadata", async () => {
  let graphRead = false;
  const input = {
    sessionId: "session-1",
    metadata: {
      activeTaskId: "task-explicit",
    },
  };

  const output = await applyActiveTaskRuntimeMetadata(input, {
    async getGraph() {
      graphRead = true;
      return {
        activeTaskId: "task-active",
      };
    },
  });

  assert.equal(output, input);
  assert.equal(graphRead, false);
});

test("persistDelegationTaskUpdateToGraph maps runtime delegation snapshots into task graph updates", async () => {
  let persisted: unknown;
  const update: DelegationTaskUpdate = {
    kind: "completed",
    task: {
      taskId: "task-child",
      parentSessionId: "session-parent",
      parentTaskId: "task-parent",
      childSessionId: "session-child",
      childSessionName: "Child",
      title: "Child work",
      status: "COMPLETED",
      profileId: "reference",
      provider: "openai",
      model: "gpt-5.4",
      resultSummary: "Done",
      references: ["file:///tmp/result.md"],
      parentRunId: "run-parent",
      createdAt: "2026-05-24T17:00:00.000Z",
      updatedAt: "2026-05-24T17:01:00.000Z",
    },
  };

  await persistDelegationTaskUpdateToGraph({
    async applyDelegationUpdate(input) {
      persisted = input;
      return {
        version: 1,
        rootTaskIds: [],
        tasks: {},
      };
    },
  }, update);

  assert.deepEqual(persisted, {
    sessionId: "session-parent",
    parentTaskId: "task-parent",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Child work",
      status: "COMPLETED",
      childSessionId: "session-child",
      resultSummary: "Done",
      references: ["file:///tmp/result.md"],
      updatedAt: "2026-05-24T17:01:00.000Z",
    },
  });
});
