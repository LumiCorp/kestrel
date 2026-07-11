import assert from "node:assert/strict";
import test from "node:test";

import type { ProductProjectAction, ProductProjectSnapshot } from "../../src/project/contracts.js";
import type { ProductTaskGraph } from "../../src/taskGraph/contracts.js";
import {
  createEmptyProjectSnapshot,
  createProductProjectActionToolAdapter,
  ProductProjectRuntimeService,
} from "../../src/index.js";
import { ProductProjectStateStore } from "../../src/project/store.js";
import { applyProjectSnapshotAction } from "../../src/project/state.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import type { RuntimeTurnResult } from "../../src/runtime/RuntimeTurn.js";
import { projectTaskProposeTool } from "../../tools/project/taskPropose.js";

test("createProductProjectActionToolAdapter applies project action with current task graph", async () => {
  const graph: ProductTaskGraph = {
    version: 1,
    rootTaskIds: ["task-main"],
    tasks: {},
  };
  const snapshot: ProductProjectSnapshot = createEmptyProjectSnapshot();
  let graphSessionId: string | undefined;
  let applied:
    | {
        sessionId: string;
        graph: ProductTaskGraph;
        action: unknown;
      }
    | undefined;
  const adapter = createProductProjectActionToolAdapter({
    taskGraphStore: {
      async getGraph(input) {
        graphSessionId = input.sessionId;
        return graph;
      },
    },
    projectStore: {
      async applyAction(input) {
        applied = input;
        return snapshot;
      },
    },
  });

  const action = {
    type: "task.propose" as const,
    actionId: "action-1",
    actionTs: "2026-05-24T18:10:00.000Z",
    sessionId: "session-project",
    title: "Task",
    instructions: "Ship the task",
  };
  const result = await adapter.apply(action);

  assert.equal(graphSessionId, "session-project");
  assert.deepEqual(applied, {
    sessionId: "session-project",
    graph,
    action,
  });
  assert.deepEqual(result, {
    sessionId: "session-project",
    snapshot,
  });
});

test("task.propose handler creates proposed Mission Control tasks through the project action adapter", async () => {
  const sessionStore = new InMemorySessionStore();
  const projectStore = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const graph: ProductTaskGraph = {
    version: 1,
    rootTaskIds: [],
    tasks: {},
  };
  const sessionId = "session-task-propose-tool";
  await projectStore.saveSnapshot(sessionId, createEmptyProjectSnapshot());
  const handler = projectTaskProposeTool.createHandler({
    projectActions: createProductProjectActionToolAdapter({
      taskGraphStore: {
        async getGraph(input) {
          assert.equal(input.sessionId, sessionId);
          return graph;
        },
      },
      projectStore,
    }),
  });

  const result = await handler({
    sessionId,
    title: "Fix auth callback",
    instructions: "Repair the auth callback regression and verify login succeeds with a regression test.",
    summary: "Proposed from the current conversation.",
  });

  const snapshot = (result as { snapshot: Awaited<ReturnType<ProductProjectStateStore["getSnapshot"]>> }).snapshot;
  const task = snapshot.taskQueue.tasks["T-1"];
  assert.equal(task?.status, "proposed");
  assert.equal(task?.createdBy, "agent");
  assert.equal(task?.title, "Fix auth callback");
  assert.equal(task?.instructions, "Repair the auth callback regression and verify login succeeds with a regression test.");
  assert.equal(task?.evidence.at(-1)?.source, "agent");
  assert.equal(task?.evidence.at(-1)?.summary, "Proposed from the current conversation.");
});

test("ProductProjectRuntimeService applies manual board moves before aborting assigned runs", async () => {
  const graph: ProductTaskGraph = {
    version: 1,
    rootTaskIds: ["task-main"],
    tasks: {},
  };
  const sessionId = "session-project-runtime-cancel";
  let snapshot: ProductProjectSnapshot = createEmptyProjectSnapshot();
  let abortFiredBeforeMoveApply = false;
  let movingCard = false;
  let abortControllerSignal: AbortSignal | undefined;
  let abortObservedResolve: (() => void) | undefined;
  const abortObserved = new Promise<void>((resolve) => {
    abortObservedResolve = resolve;
  });
  const nextAction = (
    action: Record<string, unknown> & { type: ProductProjectAction["type"] },
  ): ProductProjectAction => ({
    ...action,
    sessionId,
    actionId: `${action.type}:test`,
    actionTs: "2026-05-24T18:10:00.000Z",
  }) as ProductProjectAction;
  const projectStore = {
    async getSnapshot() {
      return snapshot;
    },
    async applyAction(input: {
      action: Parameters<typeof applyProjectSnapshotAction>[1];
    }) {
      if (input.action.type === "board.card.move") {
        movingCard = true;
        if (abortFiredBeforeMoveApply) {
          throw new Error("assigned run aborted before board move applied");
        }
      }
      snapshot = applyProjectSnapshotAction(snapshot, input.action);
      return snapshot;
    },
  } as unknown as ProductProjectStateStore;
  const runtime = new ProductProjectRuntimeService({
    taskGraphStore: {
      async getGraph() {
        return graph;
      },
    },
    projectStore,
    turnRunner: {
      async runTurn(_input, options): Promise<RuntimeTurnResult> {
        abortControllerSignal = options?.signal;
        return await new Promise<RuntimeTurnResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            if (movingCard === false) {
              abortFiredBeforeMoveApply = true;
            }
            abortObservedResolve?.();
            reject(new Error("aborted"));
          }, { once: true });
        });
      },
    },
  });

  await runtime.performProjectAction(nextAction({
    type: "board.card.create",
    title: "Cancel race",
    prompt: "Keep manual moves authoritative.",
    source: "operator",
  }));
  await runtime.performProjectAction(nextAction({
    type: "board.card.move",
    cardId: "K-1",
    targetLane: "planned",
    source: "operator",
  }));
  const started = await runtime.performProjectAction(nextAction({
    type: "board.card.start_implementation",
    cardId: "K-1",
    source: "operator",
  }));
  assert.equal(started.snapshot.board.cards["K-1"]?.lane, "wip");
  assert.equal(abortControllerSignal?.aborted, false);

  const moved = await runtime.performProjectAction(nextAction({
    type: "board.card.move",
    cardId: "K-1",
    targetLane: "planned",
    expectedBoardVersion: started.snapshot.board.boardVersion,
    source: "operator",
  }));

  await abortObserved;
  assert.equal(moved.snapshot.board.cards["K-1"]?.lane, "planned");
  assert.equal(moved.snapshot.board.cards["K-1"]?.activeClaim, undefined);
  assert.equal(abortFiredBeforeMoveApply, false);
});
