import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerInteractionRequestV1 } from "@kestrel-agents/protocol";

import { getDesktopComposerSubmissionPolicy } from "../renderer/src/composerPolicy.js";
import type { DesktopOperatorInboxItem } from "../src/contracts.js";
import {
  evaluationReviewInteractionFixture,
  recoveryReviewInteractionFixture,
} from "../../../tests/fixtures/structured-review-contract.js";


test("Desktop composer answers the exact pending user-input request", () => {
  const request = {
    itemId: "request:request-1",
    kind: "user_input_request",
    threadId: "thread-main:session-1",
    sessionId: "session-1",
    title: "Which workspace should I inspect?",
    actionable: true,
    requestId: "request-1",
    createdAt: "2026-07-20T12:00:00.000Z",
  } satisfies DesktopOperatorInboxItem;

  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [request],
    runActive: true,
  }), {
    mode: "reply_to_request",
    item: request,
  });
});

test("Desktop composer exposes exact recovery options instead of free text", () => {
  const request = {
    itemId: "request:recovery-1",
    kind: "user_input_request",
    threadId: "thread-main:session-1",
    sessionId: "session-1",
    title: "Recovery is exhausted. Choose exactly one allowed recovery option.",
    actionable: true,
    requestId: "recovery-1",
    createdAt: "2026-08-03T12:00:00.000Z",
    interaction: withRequestId(recoveryReviewInteractionFixture, "recovery-1"),
    metadata: {
      reason: "recovery_review",
      allowedOptionIds: ["retry.primary", "terminal.fail"],
      triggeringFailureCode: "RECOVERY_EXHAUSTED",
      triggeringFailureSummary: "The model response did not meet Kestrel's response contract.",
    },
  } satisfies DesktopOperatorInboxItem;

  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [request],
    runActive: false,
  }), {
    mode: "select_recovery_option",
    item: request,
    allowedOptionIds: ["retry.primary", "terminal.fail"],
    reviewKind: "recovery",
    triggeringFailureCode: "MODEL_AUTH_ERROR",
    triggeringFailureSummary: "Provider authentication failed after refresh.",
  });
});

test("Desktop composer exposes evaluation review options and disclosure", () => {
  const request = {
    itemId: "request:evaluation-1",
    kind: "user_input_request",
    threadId: "thread-main:session-1",
    sessionId: "session-1",
    title: "Result requires review.",
    actionable: true,
    requestId: "evaluation-1",
    createdAt: "2026-08-04T12:00:00.000Z",
    interaction: withRequestId(evaluationReviewInteractionFixture, "evaluation-1"),
    metadata: {
      reason: "evaluation_review",
      allowedOptionIds: [
        "evaluation.accept_once",
        "evaluation.revise",
        "terminal.fail",
      ],
      evaluationTechnicalDisclosure: {
        candidate: "Withheld candidate",
        score: 0.4,
        assertions: [],
        evidenceReferences: [],
      },
    },
  } satisfies DesktopOperatorInboxItem;

  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [request],
    runActive: false,
  }), {
    mode: "select_recovery_option",
    item: request,
    allowedOptionIds: [
      "evaluation.accept_once",
      "evaluation.revise",
      "terminal.fail",
    ],
    reviewKind: "evaluation",
    evaluationTechnicalDisclosure:
      evaluationReviewInteractionFixture.metadata.evaluationTechnicalDisclosure,
  });
});

test("Desktop composer blocks legacy recovery waits that lack a canonical interaction", () => {
  const request = {
    itemId: "request:legacy-recovery",
    kind: "user_input_request",
    threadId: "thread-main:session-1",
    sessionId: "session-1",
    title: "Recovery is exhausted. Choose exactly one allowed recovery option.",
    actionable: true,
    requestId: "legacy-recovery",
    createdAt: "2026-08-03T12:00:00.000Z",
    metadata: {
      reason: "recovery_review",
      allowedOptionIds: ["terminal.fail"],
      triggeringFailureCode: "RECOVERY_EXHAUSTED",
    },
  } satisfies DesktopOperatorInboxItem;

  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [request],
    runActive: false,
  }), {
    mode: "invalid_review",
    item: request,
    error: "This request cannot be answered safely because its interaction contract is missing.",
  });
});

test("Desktop composer ignores resolved user-input requests", () => {
  const request = {
    itemId: "request:request-1",
    kind: "user_input_request",
    threadId: "thread-main:session-1",
    sessionId: "session-1",
    title: "Which workspace should I inspect?",
    actionable: false,
    requestId: "request-1",
    createdAt: "2026-07-20T12:00:00.000Z",
  } satisfies DesktopOperatorInboxItem;

  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [request],
    runActive: false,
  }), { mode: "start_turn" });
});

test("Desktop composer queues ordinary input only while a run is active", () => {
  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [],
    runActive: true,
  }), { mode: "queue_follow_up" });
  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [],
    runActive: false,
  }), { mode: "start_turn" });
});

function withRequestId(
  fixture: object,
  requestId: string,
): RunnerInteractionRequestV1 {
  return {
    ...(structuredClone(fixture) as RunnerInteractionRequestV1),
    requestId,
  };
}
