import test from "node:test";
import assert from "node:assert/strict";

import type { ThreadInteractionView } from "../../lib/turns/client-contract";
import {
  evaluationOptionLabel,
  readEvaluationReview,
} from "./evaluation-review";
import { readThreadStructuredReview } from "../../lib/turns/structured-review";
import {
  evaluationReviewInteractionFixture,
  legacyRecoveryReviewInteractionFixture,
} from "../../tests/fixtures/structured-review-contract";

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

test("Web blocks persisted recovery envelopes as legacy waits", () => {
  const interaction = {
    id: "interaction-recovery",
    requestId: legacyRecoveryReviewInteractionFixture.requestId,
    source: "runtime",
    sourceCheckpointId: null,
    kind: "user_input",
    eventType: "user.reply",
    prompt: legacyRecoveryReviewInteractionFixture.prompt,
    status: "pending",
    requestEnvelope: structuredClone(legacyRecoveryReviewInteractionFixture),
    responseEnvelope: null,
    responseMessageId: null,
    turnId: "turn-recovery",
    assistantMessageId: "message-recovery",
    createdAt: "2026-08-04T12:00:00.000Z",
    resolvedAt: null,
  } satisfies ThreadInteractionView;

  assert.deepEqual(readThreadStructuredReview(interaction), {
    kind: "invalid_review",
    reason: "recovery_review",
    error: "This recovery request can no longer be resumed safely. End the waiting turn and retry explicitly.",
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
