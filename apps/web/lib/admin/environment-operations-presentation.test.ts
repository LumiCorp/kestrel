import assert from "node:assert/strict";
import test from "node:test";
import {
  getPlatformOperationsSummary,
  resolveEnvironmentOperationsView,
} from "./environment-operations-presentation";

test("Admin Operations defaults unknown views to the attention queue", () => {
  assert.equal(resolveEnvironmentOperationsView(), "attention");
  assert.equal(resolveEnvironmentOperationsView("unknown"), "attention");
  assert.equal(resolveEnvironmentOperationsView(["history"]), "history");
  assert.equal(resolveEnvironmentOperationsView("active"), "active");
});

test("Admin Operations distinguishes healthy and attention summaries", () => {
  assert.deepEqual(
    getPlatformOperationsSummary({
      failedCount: 0,
      duplicateDailyBackupCount: 0,
    }),
    {
      attentionCount: 0,
      needsAttention: false,
      description: "No terminal failures or backup invariant violations.",
    },
  );
  assert.deepEqual(
    getPlatformOperationsSummary({
      failedCount: 1,
      duplicateDailyBackupCount: 2,
    }),
    {
      attentionCount: 3,
      needsAttention: true,
      description: "1 failed operation and 2 backup invariant violations.",
    },
  );
});
