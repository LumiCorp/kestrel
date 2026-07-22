import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import { RuntimeDelegationService } from "../../cli/runtime/delegation.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "RuntimeDelegationService rehydrates lineage into child turn metadata", async () => {
  const store = new InMemorySessionStore();
  const childTurns: Array<{
    sessionId: string;
    message: string;
    metadata?: Record<string, unknown> | undefined;
  }> = [];
  const service = new RuntimeDelegationService({
    profile: buildProfile(),
    store,
    runChildTurn: async (input) => {
      childTurns.push(input);
    },
  });

  const task = await service.spawnTask({
    parentSessionId: "session-parent",
    parentRunId: "run-parent",
    title: "Lineage child",
    prompt: "Preserve lineage for nested spawn",
    taskId: "task-active",
    parentTaskId: "task-active",
    delegationDepth: 2,
    rootDelegationId: "delegation-root",
    launchedBy: "agent",
  });
  await tick();

  assert.deepEqual(childTurns[0]?.metadata, {
    delegationId: task.taskId,
    activeTaskId: "task-active",
    taskId: "task-active",
    parentTaskId: "task-active",
    delegationDepth: 3,
    rootDelegationId: "delegation-root",
  });

  const childSession = await store.getSession(task.childSessionId);
  assert.deepEqual(asRecord(asRecord(asRecord(childSession?.state.agent)?.delegation)?.lineage), {
    taskId: "task-active",
    parentTaskId: "task-active",
    delegationDepth: 3,
    rootDelegationId: "delegation-root",
  });
});

contractTest("runtime.hermetic", "RuntimeDelegationService rejects child spawn beyond profile delegation maxDepth", async () => {
  const store = new InMemorySessionStore();
  const service = new RuntimeDelegationService({
    profile: {
      ...buildProfile(),
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 2,
        maxDepth: 1,
      },
    },
    store,
    runChildTurn: async () => {
      throw new Error("runChildTurn should not be called after depth rejection");
    },
  });

  await assert.rejects(
    () =>
      service.spawnTask({
        parentSessionId: "session-parent",
        parentRunId: "run-parent",
        title: "Too deep",
        prompt: "Reject this nested child before launch side effects",
        parentTaskId: "task-parent",
        delegationDepth: 1,
        rootDelegationId: "delegation-root",
        launchedBy: "agent",
      }),
    (error: unknown) => {
      const failure = error as {
        code?: string | undefined;
        message?: string | undefined;
        details?: Record<string, unknown> | undefined;
      };
      assert.equal(failure.code, "DELEGATION_DEPTH_LIMIT_REACHED");
      assert.equal(failure.message, "Delegation depth limit reached (2/1).");
      assert.equal(failure.details?.classification, "policy");
      assert.equal(failure.details?.recoverable, true);
      return true;
    },
  );

  assert.deepEqual(await service.listTasks("session-parent"), []);
});

function buildProfile(): TuiProfile {
  return {
    id: "reference",
    label: "Reference",
    agent: "reference-react",
    sessionPrefix: "session",
    modelProvider: "openrouter",
    model: "mock-model",
    delegation: {
      allowAgentSpawn: true,
      maxConcurrentChildSessions: 2,
      maxDepth: 3,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
