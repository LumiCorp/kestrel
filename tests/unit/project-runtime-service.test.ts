import test from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyMissionControlProjectDocument,
  createEmptyProjectSnapshot,
  ProductProjectRuntimeService,
} from "../../src/index.js";
import type { ProductTaskGraph } from "../../src/taskGraph/contracts.js";
import { projectTaskProposeTool } from "../../tools/project/taskPropose.js";

const graph: ProductTaskGraph = {
  version: 1,
  rootTaskIds: [],
  tasks: {},
};

test(
  "ProductProjectRuntimeService exposes supporting projection and Git actions only",
  async () => {
    const calls: string[] = [];
    const service = new ProductProjectRuntimeService({
      taskGraphStore: {
        async getGraph(input) {
          calls.push(`graph:${input.sessionId}`);
          return graph;
        },
      },
      projectStore: {
        async getSnapshot() {
          calls.push("snapshot");
          return createEmptyProjectSnapshot();
        },
        async applyAction(input: { action: { type: string } }) {
          calls.push(input.action.type);
          return createEmptyProjectSnapshot();
        },
      } as never,
    });

    await service.getProjectSnapshot({ sessionId: "session-1" });
    await service.performProjectAction({
      type: "branch.create",
      sessionId: "session-1",
      branchName: "feature/one-authority",
    });

    assert.deepEqual(calls, [
      "graph:session-1",
      "snapshot",
      "graph:session-1",
      "branch.create",
    ]);
  },
);

test(
  "task.propose writes through trusted project-scoped Mission Control context",
  async () => {
    const projectId = "c10d2918-e0b6-48e4-bf3a-8dff7420b5a6";
    let received:
      | {
          projectId: string;
          title: string;
          instructions: string;
          order?: number | undefined;
        }
      | undefined;
    const handler = projectTaskProposeTool.createHandler({
      runtime: { projectId, runId: "run-1", sessionId: "session-1" },
      missionControlActions: {
        async propose(input) {
          received = input;
          return {
            projectId: input.projectId,
            schemaVersion: 1,
            revision: 1,
            authorityEpoch: 1,
            document: createEmptyMissionControlProjectDocument(input.projectId),
            createdAt: "2026-07-30T12:00:00.000Z",
            updatedAt: "2026-07-30T12:00:00.000Z",
          };
        },
      },
    });

    const result = await handler({
      title: "Fix auth callback",
      instructions: "Repair the callback and add a regression test.",
      order: 2,
    });

    assert.deepEqual(received, {
      projectId,
      title: "Fix auth callback",
      instructions: "Repair the callback and add a regression test.",
      order: 2,
    });
    assert.equal(
      (result as { projectId: string; revision: number }).projectId,
      projectId,
    );
    assert.equal((result as { revision: number }).revision, 1);
  },
);

test(
  "task.propose rejects missing project authority",
  async () => {
    const handler = projectTaskProposeTool.createHandler({
      missionControlActions: {
        async propose() {
          throw new Error("unexpected proposal");
        },
      },
    });

    await assert.rejects(
      handler({ title: "Task", instructions: "Do the task." }),
      /active registered project context/,
    );
  },
);
