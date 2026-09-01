import test from "node:test";
import assert from "node:assert/strict";
import {
  assertHostedApprovalOutcomeInvariant,
  assertVisibleCompletedOutcome,
} from "./outcome-invariant";


test("completed durable Turns require a user-visible assistant message", () => {
  assert.throws(
    () => assertVisibleCompletedOutcome("completed", 0),
    /without a user-visible answer/u
  );
  assert.doesNotThrow(() => assertVisibleCompletedOutcome("completed", 1));
  assert.doesNotThrow(() => assertVisibleCompletedOutcome("failed", 0));
});

test("hosted approval outcomes require committed success and exact retry evidence", () => {
  assert.doesNotThrow(() =>
    assertHostedApprovalOutcomeInvariant({
      kind: "success",
      effectState: "committed",
    }),
  );
  assert.doesNotThrow(() =>
    assertHostedApprovalOutcomeInvariant({
      kind: "failure",
      effectState: "not_started",
      retryable: true,
    }),
  );
  assert.throws(
    () =>
      assertHostedApprovalOutcomeInvariant({
        kind: "success",
        effectState: "not_started",
      }),
    /committed effect evidence/u,
  );
  assert.throws(
    () =>
      assertHostedApprovalOutcomeInvariant({
        kind: "failure",
        effectState: "unknown",
        retryable: true,
      }),
    /only when the effect did not start/u,
  );
});
