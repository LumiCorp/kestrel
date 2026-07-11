import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadRecord } from "../../src/kestrel/contracts/orchestration.js";

import type { OperatorThreadView } from "../../src/orchestration/contracts.js";
import { buildOperatorAffordanceFromSessionProjection } from "../../src/orchestration/OperatorAffordanceProjection.js";

test("buildOperatorAffordanceFromSessionProjection derives describe affordance from operator thread view", () => {
  const thread = buildThread("thread-main");
  const view: OperatorThreadView = {
    thread,
    activeWait: {
      kind: "approval",
      status: "active",
      actionable: true,
      sourceEventType: "user.approval",
      eventType: "user.approval",
      detail: "Approve the proposed change.",
      lineage: ["thread-main", "thread-child"],
      metadata: {
        prompt: "Approve?",
      },
    },
    latestCheckpoint: {
      checkpointId: "checkpoint-1",
      threadId: thread.threadId,
      status: "PENDING",
      recommendedAction: "operator_checkpoint",
      reason: "Review before continuing.",
      createdAt: "2026-05-24T18:20:00.000Z",
    },
    latestCheckpointDisposition: {
      status: "PENDING",
      action: "operator_checkpoint",
    },
    childThreads: [
      {
        ...buildThread("thread-child"),
        sessionId: "session-child",
        status: "WAITING",
        waitFor: {
          kind: "approval",
          eventType: "user.approval",
        },
      },
    ],
    childBlockerChain: [
      {
        threadId: "thread-child",
        title: "Child",
        status: "WAITING",
        reason: "approval",
      },
    ],
    nextAction: {
      kind: "reply",
      summary: "Approve or reject the child request.",
    },
  };

  const affordance = buildOperatorAffordanceFromSessionProjection({
    session: {
      interactionMode: "build",
      actSubmode: "safe",
    },
    projection: {
      sessionId: "session-main",
      operatorThreadView: view,
    },
  });

  assert.equal(affordance.interactionMode, "build");
  assert.equal(affordance.actSubmode, "safe");
  assert.equal(affordance.dominantBlocker, "Approve the proposed change.");
  assert.deepEqual(affordance.blockerChain, ["thread-main", "thread-child"]);
  assert.equal(affordance.latestCheckpointDisposition, "PENDING");
  assert.equal(affordance.contextPosture, "checkpoint:operator_checkpoint:pending");
  assert.equal(affordance.nextAction, "Approve or reject the child request.");
  assert.deepEqual(affordance.recommendedAction, {
    code: "operator_next_action",
    summary: "Approve or reject the child request.",
  });
  assert.deepEqual(affordance.childThreads, [
      {
        threadId: "thread-child",
        title: "thread-child",
        status: "WAITING",
        updatedAt: "2026-05-24T18:20:00.000Z",
        waitEventType: "user.approval",
    },
  ]);
  assert.deepEqual(affordance.childBlockerChainDetails, [
    {
      threadId: "thread-child",
      title: "Child",
      status: "WAITING",
      reason: "approval",
    },
  ]);
});

function buildThread(threadId: string): ThreadRecord {
  return {
    threadId,
    sessionId: "session-main",
    title: threadId,
    status: "WAITING",
    createdAt: "2026-05-24T18:20:00.000Z",
    updatedAt: "2026-05-24T18:20:00.000Z",
  };
}
