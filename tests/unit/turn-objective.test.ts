import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveKestrelTurnObjective,
  shouldPreserveTranscriptTaskForTurn,
  shouldStartFreshUserMessageTaskEpoch,
} from "../../src/runtime/turnObjective.js";


test("resume objective uses fallback goal instead of acknowledgement message", () => {
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

test("resume objective uses explicit payload goal when present", () => {
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

test("resume objective preserves transcript task over acknowledgement message", () => {
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

test("resume objective uses payload message only after explicit fallback is absent", () => {
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

test("fresh user message still starts a fresh objective from message text", () => {
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

test("canonical initial submission starts a fresh objective despite stale execution state", () => {
  const result = resolveKestrelTurnObjective({
    reactState: {
      activeTurnIntent: {
        version: "v1",
        turnId: "turn-old",
        rootEventId: "event-old",
        objective: "Tell me about this workspace",
        activeTranscriptItemId: "u-old",
      },
      observations: [{ stale: true }],
      retryContext: { attempt: 2 },
    },
    eventType: "user.message",
    eventId: "event-new",
    eventPayload: {
      message: "Document our plan and start working",
      metadata: {
        turnId: "turn-new",
        submissionKind: "initial",
      },
    },
  });

  assert.equal(result.goal, "Document our plan and start working");
  assert.equal(result.source, "fresh-user-message");
  assert.equal(result.preservesTranscriptTask, false);
});

test("canonical fresh submissions preserve the active task after their root event is initialized", () => {
  for (const submissionKind of ["initial", "follow_up"] as const) {
    const input = {
      reactState: {
        activeTurnIntent: {
          version: "v1",
          turnId: `turn-${submissionKind}`,
          rootEventId: `event-${submissionKind}`,
          objective: "Explain the like feature",
          activeTranscriptItemId: `user-${submissionKind}`,
        },
        observations: [{ summary: "Found src/app/components/LikeButton.tsx" }],
      },
      eventType: "user.message",
      eventId: `event-${submissionKind}`,
      eventPayload: {
        message: "Explain the like feature",
        metadata: {
          turnId: `turn-${submissionKind}`,
          submissionKind,
        },
      },
    };

    assert.equal(shouldPreserveTranscriptTaskForTurn(input), true);
    assert.equal(shouldStartFreshUserMessageTaskEpoch(input), false);
    assert.deepEqual(resolveKestrelTurnObjective(input), {
      goal: "Explain the like feature",
      source: "active-turn-intent",
      preservesTranscriptTask: true,
    });
  }
});

test("canonical initial submission remains fresh when only the turn id is reused", () => {
  const input = {
    reactState: {
      activeTurnIntent: {
        version: "v1",
        turnId: "turn-reused",
        rootEventId: "event-old",
        objective: "Old objective",
        activeTranscriptItemId: "user-old",
      },
    },
    eventType: "user.message",
    eventId: "event-new",
    eventPayload: {
      message: "New objective",
      metadata: {
        turnId: "turn-reused",
        submissionKind: "initial" as const,
      },
    },
  };

  assert.equal(shouldPreserveTranscriptTaskForTurn(input), false);
  assert.equal(shouldStartFreshUserMessageTaskEpoch(input), true);
  assert.equal(resolveKestrelTurnObjective(input).goal, "New objective");
});

test("canonical follow-up starts a fresh task while resume and steer preserve it", () => {
  const reactState = {
    activeTurnIntent: {
      version: "v1",
      turnId: "turn-current",
      rootEventId: "event-current",
      objective: "Implement the approved plan",
      activeTranscriptItemId: "u-current",
    },
  };

  const followUp = resolveKestrelTurnObjective({
    reactState,
    eventType: "user.follow_up",
    eventId: "event-follow-up",
    eventPayload: {
      message: "Also update the changelog",
      metadata: { turnId: "turn-follow-up", submissionKind: "follow_up" },
    },
  });
  assert.equal(followUp.goal, "Also update the changelog");
  assert.equal(followUp.preservesTranscriptTask, false);

  for (const submissionKind of ["resume", "steer"] as const) {
    const continuation = resolveKestrelTurnObjective({
      reactState,
      eventType: "user.reply",
      eventId: `event-${submissionKind}`,
      eventPayload: {
        message: submissionKind === "resume" ? "yes" : "Use the smaller API",
        metadata: { turnId: "turn-current", submissionKind },
      },
    });
    assert.equal(continuation.goal, "Implement the approved plan");
    assert.equal(continuation.source, "active-turn-intent");
    assert.equal(continuation.preservesTranscriptTask, true);
  }
});

test("legacy direct events use event identity as a fresh task epoch", () => {
  const result = resolveKestrelTurnObjective({
    reactState: {
      activeTurnIntent: {
        version: "v1",
        turnId: "event-old",
        rootEventId: "event-old",
        objective: "Old objective",
        activeTranscriptItemId: "u-old",
      },
    },
    eventType: "user.message",
    eventId: "event-new",
    eventPayload: { message: "New objective" },
  });

  assert.equal(result.goal, "New objective");
  assert.equal(result.preservesTranscriptTask, false);
});
