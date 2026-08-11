import test from "node:test";
import assert from "node:assert/strict";

import type { ThreadInteractionView } from "../../lib/turns/client-contract";
import {
  evaluationOptionLabel,
  readEvaluationReview,
  readRecoveryReview,
} from "./evaluation-review";
import { readThreadStructuredReview } from "../../lib/turns/structured-review";
import {
  evaluationReviewInteractionFixture,
  recoveryReviewInteractionFixture,
} from "../../../../tests/fixtures/structured-review-contract";

test("Web evaluation review reads only exact durable options and bounded disclosure", () => {
  const interaction = {
    id: "interaction-1",
    requestId: "evaluation-review-1",
    source: "runtime",
    sourceCheckpointId: null,
    kind: "user_input",
    eventType: "user.reply",
    prompt: "Result requires review.",
    status: "pending",
    requestEnvelope: structuredClone(evaluationReviewInteractionFixture),
    responseEnvelope: null,
    responseMessageId: null,
    turnId: "turn-1",
    assistantMessageId: "message-1",
    createdAt: "2026-08-04T12:00:00.000Z",
    resolvedAt: null,
  } satisfies ThreadInteractionView;

  assert.deepEqual(readEvaluationReview(interaction), {
    allowedOptionIds: [
      "evaluation.accept_once",
      "evaluation.revise",
      "terminal.fail",
    ],
    candidate: "Fixture candidate",
    score: 0.6,
    confidence: 0.8,
    rationale: "Fixture rationale",
    assertions: [],
    evidenceReferences: [],
  });
  assert.equal(evaluationOptionLabel("evaluation.accept_once"), "Accept once");
  assert.equal(evaluationOptionLabel("evaluation.revise"), "Revise result");
  assert.equal(evaluationOptionLabel("terminal.fail"), "Fail run");
});

test("Web reads recovery authority from the canonical request envelope", () => {
  const interaction = {
    id: "interaction-recovery",
    requestId: recoveryReviewInteractionFixture.requestId,
    source: "runtime",
    sourceCheckpointId: null,
    kind: "user_input",
    eventType: "user.reply",
    prompt: recoveryReviewInteractionFixture.prompt,
    status: "pending",
    requestEnvelope: structuredClone(recoveryReviewInteractionFixture),
    responseEnvelope: null,
    responseMessageId: null,
    turnId: "turn-recovery",
    assistantMessageId: "message-recovery",
    createdAt: "2026-08-04T12:00:00.000Z",
    resolvedAt: null,
  } satisfies ThreadInteractionView;

  assert.deepEqual(readThreadStructuredReview(interaction), {
    kind: "structured_review",
    reason: "recovery_review",
    requestId: "recovery-review-fixture",
    eventType: "user.reply",
    prompt: "Kestrel could not continue. Choose one recovery option.",
    allowedOptionIds: ["retry.primary", "terminal.fail"],
    triggeringFailureCode: "MODEL_AUTH_ERROR",
    triggeringFailureSummary: "Provider authentication failed after refresh.",
  });
});

test("Web ordinary runtime questions are not misclassified as evaluation review", () => {
  const interaction = {
    id: "interaction-2",
    requestId: "question-1",
    source: "runtime",
    sourceCheckpointId: null,
    kind: "user_input",
    eventType: "user.reply",
    prompt: "Which workspace?",
    status: "pending",
    requestEnvelope: {},
    responseEnvelope: null,
    responseMessageId: null,
    turnId: "turn-2",
    assistantMessageId: "message-2",
    createdAt: "2026-08-04T12:00:00.000Z",
    resolvedAt: null,
  } satisfies ThreadInteractionView;

  assert.equal(readEvaluationReview(interaction), null);
});

test("Web recovery review requires server-authored descriptors for every allowed option", () => {
  const interaction = {
    id: "interaction-3",
    requestId: "recovery-review-1",
    source: "runtime",
    sourceCheckpointId: null,
    kind: "user_input",
    eventType: "user.reply",
    prompt: "Choose a recovery option.",
    status: "pending",
    requestEnvelope: {
      metadata: {
        reason: "recovery_review",
        allowedOptionIds: ["retry.primary", "terminal.fail"],
        recoveryReviewBinding: {
          version: "recovery_review_binding_v1",
          bindingId: "recovery-review-1",
          decisionId: "recovery-decision-1",
          threadId: "thread-3",
          runId: "run-3",
          executionProfileFingerprint: "c".repeat(64),
          policyRevision: `sha256:${"d".repeat(64)}`,
          allowedOptionIds: ["retry.primary", "terminal.fail"],
          requestedAt: "2026-08-11T12:00:00.000Z",
        },
        recoveryOptions: [
          {
            id: "retry.primary",
            label: "Retry",
            description: "Retry the primary recovery route.",
            kind: "retry",
          },
          {
            id: "terminal.fail",
            label: "Stop",
            description: "Stop recovery and fail this run.",
            kind: "terminal",
          },
        ],
      },
    },
    responseEnvelope: null,
    responseMessageId: null,
    turnId: "turn-3",
    assistantMessageId: "message-3",
    createdAt: "2026-08-11T12:00:00.000Z",
    resolvedAt: null,
  } satisfies ThreadInteractionView;

  assert.deepEqual(readRecoveryReview(interaction), {
    options: [
      {
        id: "retry.primary",
        label: "Retry",
        description: "Retry the primary recovery route.",
        kind: "retry",
      },
      {
        id: "terminal.fail",
        label: "Stop",
        description: "Stop recovery and fail this run.",
        kind: "terminal",
      },
    ],
  });
});
