import assert from "node:assert/strict";

import { resolveKestrelTurnObjective } from "../../src/runtime/turnObjective.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "resume objective uses fallback goal instead of acknowledgement message", () => {
  const result = resolveKestrelTurnObjective({
    reactState: {},
    eventType: "user.message",
    eventPayload: {
      message: "switch to build",
      resumeBlockedRun: true,
    },
    fallbackGoal: "Build the app",
  });

  assert.equal(result.goal, "Build the app");
  assert.equal(result.source, "fallback");
  assert.equal(result.preservesTranscriptTask, true);
});

contractTest("runtime.hermetic", "resume objective uses explicit payload goal when present", () => {
  const result = resolveKestrelTurnObjective({
    reactState: {},
    eventType: "user.message",
    eventPayload: {
      message: "approved",
      goal: "Finish the implementation",
      resumeBlockedRun: true,
    },
    fallbackGoal: "Fallback objective",
  });

  assert.equal(result.goal, "Finish the implementation");
  assert.equal(result.source, "payload");
});

contractTest("runtime.hermetic", "resume objective preserves transcript task over acknowledgement message", () => {
  const result = resolveKestrelTurnObjective({
    reactState: {
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "u1",
            createdAt: "2026-07-06T00:00:00.000Z",
            kind: "user",
            content: "Build the dashboard export flow",
          },
        ],
      },
    },
    eventType: "user.message",
    eventPayload: {
      message: "continue",
      resumeBlockedRun: true,
    },
    fallbackGoal: "Fallback objective",
  });

  assert.equal(result.goal, "Build the dashboard export flow");
  assert.equal(result.source, "transcript");
});

contractTest("runtime.hermetic", "resume objective uses payload message only after explicit fallback is absent", () => {
  const result = resolveKestrelTurnObjective({
    reactState: {},
    eventType: "user.message",
    eventPayload: {
      message: "tell me more about the Crosby deal falling through",
      resumeBlockedRun: true,
    },
  });

  assert.equal(result.goal, "tell me more about the Crosby deal falling through");
  assert.equal(result.source, "payload");
});

contractTest("runtime.hermetic", "fresh user message still starts a fresh objective from message text", () => {
  const result = resolveKestrelTurnObjective({
    reactState: {},
    eventType: "user.message",
    eventPayload: {
      message: "Build the dashboard export flow",
    },
    fallbackGoal: "Fallback objective",
  });

  assert.equal(result.goal, "Build the dashboard export flow");
  assert.equal(result.source, "fresh-user-message");
  assert.equal(result.preservesTranscriptTask, false);
});
