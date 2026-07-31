import assert from "node:assert/strict";

import * as kestrel from "../../src/index.js";
import { parseMissionControlLegacyProjectSnapshot } from "../../src/missionControl/legacyContracts.js";
import {
  createEmptyMissionControlProjectDocument,
  parseMissionControlProjectStateRecord,
} from "../../src/missionControl/projectAuthority.js";
import {
  createEmptyProjectSnapshot,
  normalizeProjectSnapshot,
} from "../../src/project/state.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest(
  "runtime.hermetic",
  "retired session Mission Control reducers and snapshot authorities are absent",
  () => {
    assert.equal("applyTaskQueueAction" in kestrel, false);
    assert.equal("createEmptyTaskQueue" in kestrel, false);
    assert.equal("parseTaskAction" in kestrel, false);
    assert.equal("applyProductProjectBoardAction" in kestrel, false);

    const normalized = normalizeProjectSnapshot({
      ...createEmptyProjectSnapshot(),
      taskQueue: { tasks: { "T-1": {} } },
      board: { cards: { "K-1": {} } },
    });
    assert.equal("taskQueue" in normalized, false);
    assert.equal("board" in normalized, false);
  },
);

contractTest(
  "runtime.hermetic",
  "legacy Mission Control records remain read-only and provenance complete",
  () => {
    const snapshot = parseMissionControlLegacyProjectSnapshot({
      ...createEmptyProjectSnapshot(),
      taskQueue: {
        version: 1,
        queueVersion: 3,
        nextTaskNumber: 2,
        tasks: {
          "T-1": {
            id: "T-1",
            title: "Historical task",
            instructions: "Preserve its review record.",
            status: "ready_for_review",
            priority: "high",
            createdBy: "agent",
            order: 1,
            attentionReason: "approval_needed",
            evidence: [{
              id: "evidence-1",
              timestamp: "2026-07-30T12:00:00.000Z",
              source: "runtime",
              summary: "Historical execution completed.",
              threadId: "thread-1",
              runId: "run-1",
            }],
            review: {
              submittedAt: "2026-07-30T12:01:00.000Z",
              summary: "Ready for historical review.",
              changedFileCount: 2,
              testsSummary: "Passed.",
            },
          },
        },
      },
      board: {
        version: 1,
        boardVersion: 4,
        nextCardNumber: 2,
        settings: {
          autopilotEnabled: false,
          wipLimit: 1,
        },
        cards: {
          "K-1": {
            id: "K-1",
            title: "Historical card",
            prompt: "Preserve its active claim.",
            lane: "wip",
            order: 0,
            activeClaim: {
              threadId: "thread-1",
              sessionId: "session-1",
              kind: "implementation",
              claimedAt: "2026-07-30T12:00:00.000Z",
              claimReason: "copilot",
            },
            threads: [],
            evidence: [],
          },
        },
      },
    });

    assert.equal(snapshot.taskQueue.tasks["T-1"]?.review?.changedFileCount, 2);
    assert.equal(
      snapshot.taskQueue.tasks["T-1"]?.evidence[0]?.runId,
      "run-1",
    );
    assert.equal(snapshot.board.cards["K-1"]?.activeClaim?.threadId, "thread-1");
    assert.equal(snapshot.board.cards["K-1"]?.createdAt, "1970-01-01T00:00:00.000Z");
  },
);

contractTest(
  "runtime.hermetic",
  "canonical Mission Control state rejects an inactive authority epoch",
  () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    assert.throws(
      () =>
        parseMissionControlProjectStateRecord({
          projectId,
          schemaVersion: 1,
          revision: 0,
          authorityEpoch: 0,
          document: createEmptyMissionControlProjectDocument(projectId),
          createdAt: "2026-07-30T12:00:00.000Z",
          updatedAt: "2026-07-30T12:00:00.000Z",
        }),
      /authorityEpoch must be a positive safe integer/u,
    );
  },
);
