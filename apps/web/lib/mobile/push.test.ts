import assert from "node:assert/strict";
import test from "node:test";
import { buildMobilePushMessage } from "./push-payload";

test("mobile push payloads deep-link without transcript or Project content", () => {
  const message = buildMobilePushMessage({
    token: "ExponentPushToken[device]",
    kind: "attention",
    organizationId: "org_123",
    threadId: "thread_123",
    turnId: "turn_123",
  });
  assert.deepEqual(message, {
    to: "ExponentPushToken[device]",
    sound: "default",
    title: "Kestrel One",
    body: "Your agent needs your attention.",
    data: {
      type: "turn.attention",
      organizationId: "org_123",
      threadId: "thread_123",
      turnId: "turn_123",
    },
  });
  const serialized = JSON.stringify(message);
  for (const forbidden of [
    "prompt",
    "transcript",
    "responseText",
    "projectName",
    "email",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "iu"));
  }
});
