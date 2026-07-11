import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLaunchPolicy } from "../../src/orchestration/Supervision.js";

test("normalizeLaunchPolicy preserves existing supervision intent while normalizing depth policy", () => {
  const policy = normalizeLaunchPolicy({
    parentThreadId: "thread-parent",
    policy: {
      depth: 1.8,
      maxDepth: 3.2,
      rootDelegationId: " delegation-root ",
      parentTaskId: " task-parent ",
      sourceCheckpointId: "checkpoint-1",
      supervision: {
        groupId: "group-existing",
        rolePrompt: "Review implementation",
        goal: "Find runtime regressions",
        budget: {
          maxTurns: 2,
          allowApprovalInheritance: false,
        },
        reconciliationIntent: "manual_review",
        resultState: "blocked",
        outcomeReason: "Waiting on a prior child",
        supersededAt: "2026-05-19T00:00:00.000Z",
        supersededBy: "operator",
        latestFanInDisposition: "deferred",
        latestFanInCheckpointId: "checkpoint-fanin-stale",
      },
    },
  });

  assert.equal(policy.depth, 1);
  assert.equal(policy.maxDepth, 3);
  assert.equal(policy.rootDelegationId, "delegation-root");
  assert.equal(policy.parentTaskId, "task-parent");
  assert.equal(policy.sourceCheckpointId, "checkpoint-1");
  assert.deepEqual(policy.supervision, {
    groupId: "group-existing",
    rolePrompt: "Review implementation",
    goal: "Find runtime regressions",
    budget: {
      maxTurns: 2,
      allowApprovalInheritance: false,
    },
    reconciliationIntent: "manual_review",
    resultState: "running",
  });
});

test("normalizeLaunchPolicy lets explicit launch inputs override existing supervision fields", () => {
  const policy = normalizeLaunchPolicy({
    parentThreadId: "thread-parent",
    rolePrompt: "New role",
    goal: "New goal",
    budget: {
      maxTurns: 4,
      allowApprovalInheritance: true,
    },
    supervisionGroupId: "group-new",
    reconciliationIntent: "auto_when_safe",
    policy: {
      supervision: {
        groupId: "group-existing",
        rolePrompt: "Old role",
        goal: "Old goal",
        budget: {
          maxTurns: 1,
        },
        reconciliationIntent: "manual_review",
        resultState: "running",
      },
    },
  });

  assert.deepEqual(policy.supervision, {
    groupId: "group-new",
    rolePrompt: "New role",
    goal: "New goal",
    budget: {
      maxTurns: 4,
      allowApprovalInheritance: true,
    },
    reconciliationIntent: "auto_when_safe",
    resultState: "running",
  });
  assert.equal(policy.allowApprovalInheritance, true);
  assert.equal(policy.maxTurns, 4);
});
