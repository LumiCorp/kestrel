import assert from "node:assert/strict";
import { assertVisibleCompletedOutcome } from "./outcome-invariant";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "completed durable Turns require a user-visible assistant message", () => {
  assert.throws(
    () => assertVisibleCompletedOutcome("completed", 0),
    /without a user-visible answer/u
  );
  assert.doesNotThrow(() => assertVisibleCompletedOutcome("completed", 1));
  assert.doesNotThrow(() => assertVisibleCompletedOutcome("failed", 0));
});
