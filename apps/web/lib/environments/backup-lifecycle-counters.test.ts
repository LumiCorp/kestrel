import assert from "node:assert/strict";
import test from "node:test";
import { workspaceBackupOutcomeCounters } from "./backups";
import { remainingBackupLifecycleBatchBudget } from "./reconcile";

test("backup lifecycle outcomes emit the complete stable counter contract", () => {
  assert.deepEqual(workspaceBackupOutcomeCounters("created"), {
    inspected: 1,
    unchanged: 0,
    created: 1,
    reused: 0,
    expired: 0,
    deletionFailed: 0,
    oversized: 0,
  });
  assert.deepEqual(workspaceBackupOutcomeCounters("reused"), {
    inspected: 1,
    unchanged: 1,
    created: 0,
    reused: 1,
    expired: 0,
    deletionFailed: 0,
    oversized: 0,
  });
  assert.deepEqual(workspaceBackupOutcomeCounters("oversized"), {
    inspected: 1,
    unchanged: 0,
    created: 0,
    reused: 0,
    expired: 0,
    deletionFailed: 0,
    oversized: 1,
  });
});

test("backup lifecycle reconciliation shares one bounded batch budget", () => {
  assert.equal(remainingBackupLifecycleBatchBudget(100, 0), 100);
  assert.equal(remainingBackupLifecycleBatchBudget(100, 63), 37);
  assert.equal(remainingBackupLifecycleBatchBudget(100, 100), 0);
  assert.equal(remainingBackupLifecycleBatchBudget(500, 99), 1);
});
