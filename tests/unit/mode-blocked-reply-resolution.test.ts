import test from "node:test";
import assert from "node:assert/strict";

import { resolveModeBlockedReplyAtRuntime } from "../../src/runtime/modeBlockedReplyResolution.js";
import type { UserReplyIntent } from "../../src/runtime/userReplyIntent.js";

const request = {
  requestId: "request-1",
  runId: "run-2",
  eventType: "user.reply",
  metadata: {
    reason: "planner_mode_blocked",
    requiredToolClass: "external_side_effect",
    requiredCapabilities: ["dev.shell"],
  },
};

test("explicit required mode resumes the blocked action without classification", async () => {
  let classifications = 0;
  const result = await resolveModeBlockedReplyAtRuntime({
    request,
    message: "/mode build",
    currentMode: "chat",
    classify: async () => {
      classifications += 1;
      return ambiguousIntent();
    },
  });

  assert.equal(classifications, 0);
  assert.deepEqual(result?.modeResolution, {
    version: "mode_resolution_v1",
    requestId: "request-1",
    runId: "run-2",
    interactionMode: "build",
    source: "explicit_command",
    disposition: "resume",
  });
});

test("natural acceptance uses the required mode and resumes", async () => {
  const result = await resolveModeBlockedReplyAtRuntime({
    request,
    message: "yes please do it",
    currentMode: "chat",
    classify: async () => ({
      kind: "mode_switch",
      proceed: true,
      confidence: "high",
    }),
  });

  assert.equal(result?.modeResolution.interactionMode, "build");
  assert.equal(result?.modeResolution.source, "classified_reply");
  assert.equal(result?.modeResolution.disposition, "resume");
});

test("clear denial keeps the current mode and declines the blocked action", async () => {
  const result = await resolveModeBlockedReplyAtRuntime({
    request,
    message: "no, don't do that",
    currentMode: "chat",
    classify: async () => ({
      kind: "mode_switch",
      proceed: false,
      confidence: "high",
    }),
  });

  assert.equal(result?.modeResolution.interactionMode, "chat");
  assert.equal(result?.modeResolution.disposition, "decline");
});

test("another explicit mode is persisted but does not resume the blocked action", async () => {
  const result = await resolveModeBlockedReplyAtRuntime({
    request,
    message: "/mode plan",
    currentMode: "chat",
    classify: async () => ambiguousIntent(),
  });

  assert.equal(result?.modeResolution.interactionMode, "plan");
  assert.equal(result?.modeResolution.disposition, "decline");
});

test("ambiguous natural reply keeps the current mode and asks for clarification", async () => {
  const result = await resolveModeBlockedReplyAtRuntime({
    request,
    message: "maybe, but I'm not sure",
    currentMode: "chat",
    classify: async () => ambiguousIntent(),
  });

  assert.equal(result?.modeResolution.interactionMode, "chat");
  assert.equal(result?.modeResolution.disposition, "clarify");
});

test("legacy class-only waits still resolve to their required mode", async () => {
  const result = await resolveModeBlockedReplyAtRuntime({
    request: {
      ...request,
      metadata: {
        reason: "planner_mode_blocked",
        requiredToolClass: "planning_write",
      },
    },
    message: "go ahead",
    currentMode: "chat",
    classify: async () => ({
      kind: "mode_switch",
      proceed: true,
      confidence: "high",
    }),
  });

  assert.equal(result?.modeResolution.interactionMode, "plan");
  assert.equal(result?.modeResolution.disposition, "resume");
});

function ambiguousIntent(): UserReplyIntent {
  return {
    kind: "unrelated",
    proceed: false,
    confidence: "low",
  };
}
