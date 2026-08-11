import assert from "node:assert/strict";
import test from "node:test";
import {
  nextMessageFeedback,
  patchMessageFeedback,
} from "./message-feedback";

test("selected feedback toggles off and the opposite selection replaces it", () => {
  assert.equal(nextMessageFeedback(null, "positive"), "positive");
  assert.equal(nextMessageFeedback("positive", "positive"), null);
  assert.equal(nextMessageFeedback("negative", "positive"), "positive");
});

test("feedback requests reject non-success HTTP responses", async () => {
  await assert.rejects(
    patchMessageFeedback({
      feedback: "positive",
      fetchImpl: async () =>
        Response.json({ error: "Feedback was rejected" }, { status: 409 }),
      messageId: "message-1",
      threadId: "thread-1",
    }),
    /Feedback was rejected/
  );
});
