import test from "node:test";
import assert from "node:assert/strict";

import { clearDesktopThreadError, updateDesktopThreadFeedback } from "../renderer/src/feedbackState.js";

test("Desktop feedback updates only its owning conversation", () => {
  const initial = {
    a: { activity: "Running" },
    b: { activity: "Ready", error: "Keep B" },
  };
  const failedA = updateDesktopThreadFeedback(initial, "a", { activity: "Run failed", error: "A failed" });
  assert.deepEqual(failedA.a, { activity: "Run failed", error: "A failed" });
  assert.equal(failedA.b, initial.b);
  const clearedA = clearDesktopThreadError(failedA, "a");
  assert.deepEqual(clearedA.a, { activity: "Run failed" });
  assert.equal(clearedA.b, initial.b);
});
