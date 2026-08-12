import assert from "node:assert/strict";
import test from "node:test";
import { getEnvironmentActivityPresentation } from "./activity-presentation";

test("Environment Activity prioritizes active and failed operations and runs", () => {
  const result = getEnvironmentActivityPresentation({
    operations: [
      { id: "queued", status: "queued" },
      { id: "failed-operation", status: "failed" },
      { id: "completed-operation", status: "completed" },
    ],
    runs: [
      { id: "routed", status: "routed" },
      { id: "running", status: "running" },
      { id: "failed-run", status: "failed" },
      { id: "completed-run", status: "completed" },
    ],
  });

  assert.deepEqual(
    result.visibleOperations.map((operation) => operation.id),
    ["queued", "failed-operation"],
  );
  assert.deepEqual(
    result.completedOperations.map((operation) => operation.id),
    ["completed-operation"],
  );
  assert.deepEqual(
    result.visibleRuns.map((run) => run.id),
    ["routed", "running", "failed-run"],
  );
  assert.deepEqual(
    result.completedRuns.map((run) => run.id),
    ["completed-run"],
  );
  assert.equal(result.activeCount, 3);
  assert.equal(result.failureCount, 2);
  assert.equal(result.status, "Needs attention");
  assert.equal(result.tone, "warning");
});

test("Environment Activity distinguishes work in progress from a quiet state", () => {
  assert.deepEqual(
    getEnvironmentActivityPresentation({
      operations: [{ status: "running" }],
      runs: [],
    }),
    {
      visibleOperations: [{ status: "running" }],
      completedOperations: [],
      visibleRuns: [],
      completedRuns: [],
      activeCount: 1,
      failureCount: 0,
      status: "Work in progress",
      tone: "neutral",
    },
  );
  assert.deepEqual(
    getEnvironmentActivityPresentation({ operations: [], runs: [] }),
    {
      visibleOperations: [],
      completedOperations: [],
      visibleRuns: [],
      completedRuns: [],
      activeCount: 0,
      failureCount: 0,
      status: "Quiet",
      tone: "positive",
    },
  );
});
