import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWaitingSystemText,
  extractWaitPrompt,
  formatExactReviewPrompt,
  readExactReviewOptionIds,
  resolveExactReviewOptionId,
  resolveBlockedWaitModeReply,
} from "../../cli/app/waitForPrompt.js";
import { extractWaitPrompt as extractSharedWaitPrompt } from "../../src/runtime/waitForPrompt.js";
import {
  evaluationReviewInteractionFixture,
  legacyRecoveryReviewInteractionFixture,
} from "../fixtures/structured-review-contract.js";


test("extractWaitPrompt returns prompt from wait metadata", () => {
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: {
      prompt: "Should I proceed?",
    },
  };

  assert.equal(extractWaitPrompt(waitFor), "Should I proceed?");
});

test("shared wait prompt extraction retains the legacy direct prompt shape", () => {
  assert.equal(
    extractSharedWaitPrompt({
      eventType: "user.reply",
      prompt: "  Which workspace should I inspect?  ",
    }),
    "Which workspace should I inspect?",
  );
});

test("buildWaitingSystemText includes prompt when present", () => {
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: {
      prompt: "Please confirm your city.",
    },
  };

  assert.equal(
    buildWaitingSystemText(waitFor),
    [
      "Waiting for your reply.",
      "Please confirm your city.",
      "Reply in chat with the requested information to resume the run.",
    ].join("\n"),
  );
});

test("buildWaitingSystemText falls back to generic waiting text", () => {
  assert.equal(
    buildWaitingSystemText({
      kind: "user",
      eventType: "user.reply",
    }),
    [
      "Waiting for your reply.",
      "Reply in chat to resume the run.",
    ].join("\n"),
  );
});

test("evaluation review exposes and resolves only exact authored options", () => {
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: {
      reason: "evaluation_review",
      prompt: "Result requires review.",
      allowedOptionIds: ["evaluation.accept_once", "terminal.fail"],
    },
    interaction: structuredClone(evaluationReviewInteractionFixture),
  };

  assert.deepEqual(readExactReviewOptionIds(waitFor), [
    "evaluation.accept_once",
    "evaluation.revise",
    "terminal.fail",
  ]);
  assert.equal(
    resolveExactReviewOptionId(waitFor, "evaluation.accept_once"),
    "evaluation.accept_once",
  );
  assert.equal(resolveExactReviewOptionId(waitFor, "accept"), undefined);
  assert.equal(resolveExactReviewOptionId(waitFor, "2"), "evaluation.revise");
  assert.equal(
    formatExactReviewPrompt(waitFor, "Result requires review."),
    [
      "Result requires review.",
      "1. Accept once",
      "2. Revise result",
      "3. Fail run",
      "Enter a number or the exact option ID. Use /stop to end the waiting run.",
    ].join("\n"),
  );
});

test("persisted recovery review is blocked and directs the operator to stop", () => {
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: { reason: "recovery_review" },
    interaction: structuredClone(legacyRecoveryReviewInteractionFixture),
  };

  assert.equal(resolveExactReviewOptionId(waitFor, "1"), undefined);
  assert.equal(resolveExactReviewOptionId(waitFor, "Try again"), undefined);
  assert.equal(
    formatExactReviewPrompt(waitFor, undefined),
    "This recovery request can no longer be resumed safely. End the waiting turn and retry explicitly. Use /stop to end the waiting run.",
  );
});

test("legacy structured review wait is blocked and directs the operator to stop", () => {
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: { reason: "recovery_review" },
  };

  assert.deepEqual(readExactReviewOptionIds(waitFor), []);
  assert.equal(resolveExactReviewOptionId(waitFor, "retry.primary"), undefined);
  assert.equal(
    formatExactReviewPrompt(waitFor, undefined),
    "This request cannot be answered safely because its interaction contract is missing. Use /stop to end the waiting run.",
  );
});

test("buildWaitingSystemText renders the canonical contextual step-continuation prompt", () => {
  assert.equal(
    buildWaitingSystemText({
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "max_steps_continuation",
        question: "I’ve narrowed the list to independent barbers. Next I’ll verify the top contenders. Want me to continue?",
        extraStepsRequested: 1_000,
        completedSoFar: ["Gathered Cincinnati barber candidates.", "Filtered out chain shops."],
        blockedOn: "Need more steps to verify the top contenders.",
        nextIfApproved: ["Run the remaining web searches.", "Synthesize the top 3 answer."],
      },
    }),
    [
      "Waiting for your reply.",
      "I’ve narrowed the list to independent barbers. Next I’ll verify the top contenders. Want me to continue?",
      "Reply naturally to continue, or say: `continue`",
    ].join("\n"),
  );
});

test("buildWaitingSystemText does not duplicate continuation diagnostics", () => {
  assert.equal(
    buildWaitingSystemText({
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "max_model_calls_continuation",
        question: "I’ve collected the implementation evidence. Next I’ll finish verification and synthesize the answer. Keep going?",
        extraModelCallsRequested: 100,
        extraStepsRequested: 1_000,
        completedSoFar: ["Used fs.read_text.", "Collected evidence for dev.shell."],
        blockedOn: "I hit the current step budget before I could finish verification.",
        nextIfApproved: ["Run fs.read_text to gather missing evidence.", "Synthesize the final answer."],
      },
    }),
    [
      "Waiting for your reply.",
      "I’ve collected the implementation evidence. Next I’ll finish verification and synthesize the answer. Keep going?",
      "Reply naturally to continue, or say: `continue`",
    ].join("\n"),
  );
});

test("resolveBlockedWaitModeReply accepts natural-language build mode switches for blocked waits", () => {
  const resolved = resolveBlockedWaitModeReply(
    {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "planner_mode_blocked",
      },
    },
    "switch to build",
    {
      kind: "mode_switch",
      proceed: true,
      interactionMode: "build",
      confidence: "high",
    },
  );

  assert.deepEqual(resolved, {
    interactionMode: "build",
    acknowledgement: "Mode set to Build. Resuming blocked run.",
    resumeBlockedRun: true,
  });
});

test("buildWaitingSystemText formats acter mode-blocked waits with the required mode guidance", () => {
  assert.equal(
    buildWaitingSystemText({
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "acter_mode_blocked",
        requiredToolClass: "external_side_effect",
        toolName: "effect:user_message",
        question:
          "You're in 'Build'. Can I stay in 'Build' so I can use an external side-effect tool?",
        resumeReply: "switch to build",
        resumeCommand: "/mode build",
        prompt:
          [
            "Question: You're in 'Build'. Can I stay in 'Build' so I can use an external side-effect tool?",
            "Reply naturally to approve the switch, name the mode, or run: `/mode build`",
            "The run will resume automatically.",
          ].join("\n"),
      },
    }),
    [
      "Waiting for your reply.",
      "You're in 'Build'. Can I stay in 'Build' so I can use an external side-effect tool?",
      "Reply naturally to approve the switch, name the mode, or run: `/mode build`",
      "The run will resume automatically.",
    ].join("\n"),
  );
});

test("resolveBlockedWaitModeReply accepts build switches for acter-blocked waits", () => {
  const resolved = resolveBlockedWaitModeReply(
    {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "acter_mode_blocked",
      },
    },
    "switch to build",
    {
      kind: "mode_switch",
      proceed: true,
      interactionMode: "build",
      confidence: "high",
    },
  );

  assert.deepEqual(resolved, {
    interactionMode: "build",
    acknowledgement: "Mode set to Build. Resuming blocked run.",
    resumeBlockedRun: true,
  });
});

test("resolveBlockedWaitModeReply ignores natural-language mode switches outside blocked waits", () => {
  const resolved = resolveBlockedWaitModeReply(
    {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "extractor_clarification",
      },
    },
    "switch to build",
  );

  assert.equal(resolved, undefined);
});

test("resolveBlockedWaitModeReply rejects non-string replies without throwing", () => {
  const resolved = resolveBlockedWaitModeReply(
    {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "planner_mode_blocked",
      },
    },
    { message: "switch to build" },
  );

  assert.equal(resolved, undefined);
});
