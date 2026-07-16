import assert from "node:assert/strict";
import test from "node:test";
import { assertVisibleCompletedOutcome } from "./outcome-invariant";

test("completed durable Turns require a user-visible assistant message", () => {
  assert.throws(
    () => assertVisibleCompletedOutcome("completed", 0),
    /without a user-visible answer/u
  );
  assert.doesNotThrow(() => assertVisibleCompletedOutcome("completed", 1));
  assert.doesNotThrow(() => assertVisibleCompletedOutcome("failed", 0));
});
