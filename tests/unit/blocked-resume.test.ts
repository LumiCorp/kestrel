import assert from "node:assert/strict";

import { resolveBlockedResumeRequest } from "../../agents/reference-react/src/blockedResume.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "blocked resume ignores stale agent goal when transcript exists without active task", () => {
  const result = resolveBlockedResumeRequest(
    {
      goal: "Build Chirp, a text-only microblogging app.",
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "mt_1_0001_assistant_text",
            createdAt: "2026-07-06T12:00:00.000Z",
            kind: "assistant_text",
            content: "No user task survived.",
          },
        ],
      },
      waitingFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "planner_mode_blocked",
        },
      },
    },
    {
      type: "user.reply",
      payload: {
        message: "/mode build",
        resumeBlockedRun: true,
      },
    },
  );

  assert.equal(result.applyEventOverride, false);
  assert.equal(result.goal, undefined);
  assert.equal(result.userRequest, undefined);
  assert.equal(result.interactionMode, "build");
  assert.equal(result.resumeBlockedRun, true);
});

contractTest("runtime.hermetic", "blocked resume ignores legacy agent goal when no transcript exists", () => {
  const result = resolveBlockedResumeRequest(
    {
      goal: "Build Chirp, a text-only microblogging app.",
      waitingFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "planner_mode_blocked",
        },
      },
    },
    {
      type: "user.reply",
      payload: {
        message: "/mode build",
        resumeBlockedRun: true,
      },
    },
  );

  assert.equal(result.applyEventOverride, false);
  assert.equal(result.goal, undefined);
  assert.equal(result.userRequest, undefined);
  assert.equal(result.interactionMode, "build");
  assert.equal(result.resumeBlockedRun, true);
});

contractTest("runtime.hermetic", "blocked resume uses transcript task for task fields", () => {
  const result = resolveBlockedResumeRequest(
    {
      goal: "Stale legacy task",
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "mt_1_0001_user",
            createdAt: "2026-07-06T12:00:00.000Z",
            kind: "user",
            content: "Build Chirp, a text-only microblogging app.",
          },
        ],
      },
      waitingFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "planner_mode_blocked",
        },
      },
    },
    {
      type: "user.reply",
      payload: {
        message: "/mode build",
        resumeBlockedRun: true,
      },
    },
  );

  assert.equal(result.applyEventOverride, true);
  assert.equal(result.goal, "Build Chirp, a text-only microblogging app.");
  assert.equal(result.userRequest, "Build Chirp, a text-only microblogging app.");
  assert.equal(result.interactionMode, "build");
  assert.equal(result.resumeBlockedRun, true);
});
