import test from "node:test";
import assert from "node:assert/strict";

import type { ThreadInteractionView } from "../../lib/turns/client-contract";
import {
  evaluationOptionLabel,
  readEvaluationReview,
} from "./evaluation-review";

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
    requestEnvelope: {
      metadata: {
        reason: "evaluation_review",
        allowedOptionIds: ["evaluation.accept_once", "terminal.fail"],
        recoveryReviewBinding: {
          version: "recovery_review_binding_v1",
          bindingId: "evaluation-review-1",
          decisionId: "evaluation-decision-1",
          threadId: "thread-1",
          runId: "run-1",
          executionProfileFingerprint: "a".repeat(64),
          policyRevision: `sha256:${"b".repeat(64)}`,
          allowedOptionIds: ["evaluation.accept_once", "terminal.fail"],
          requestedAt: "2026-08-04T12:00:00.000Z",
        },
        evaluationTechnicalDisclosure: {
          candidate: "Withheld result.",
          score: 0.42,
          confidence: 0.81,
          rationale: "The result lacks evidence.",
          assertions: [{
            assertionId: "evidence_consistent",
            passed: false,
            rationale: "No durable reference was supplied.",
          }],
          evidenceReferences: ["artifact:1"],
        },
      },
    },
    responseEnvelope: null,
    responseMessageId: null,
    turnId: "turn-1",
    assistantMessageId: "message-1",
    createdAt: "2026-08-04T12:00:00.000Z",
    resolvedAt: null,
  } satisfies ThreadInteractionView;

  assert.deepEqual(readEvaluationReview(interaction), {
    allowedOptionIds: ["evaluation.accept_once", "terminal.fail"],
    candidate: "Withheld result.",
    score: 0.42,
    confidence: 0.81,
    rationale: "The result lacks evidence.",
    assertions: [{
      assertionId: "evidence_consistent",
      passed: false,
      rationale: "No durable reference was supplied.",
    }],
    evidenceReferences: ["artifact:1"],
  });
  assert.equal(evaluationOptionLabel("evaluation.accept_once"), "Accept once");
  assert.equal(evaluationOptionLabel("evaluation.revise"), "Revise result");
  assert.equal(evaluationOptionLabel("terminal.fail"), "Fail run");
});

test("Web generic recovery review reads exact options from its binding", () => {
  const interaction = {
    id: "interaction-3",
    requestId: "recovery-review-1",
    source: "runtime",
    sourceCheckpointId: null,
    kind: "user_input",
    eventType: "user.reply",
    prompt: "Choose recovery.",
    status: "pending",
    requestEnvelope: {
      metadata: {
        reason: "recovery_review",
        recoveryReviewBinding: {
          version: "recovery_review_binding_v1",
          bindingId: "recovery-review-1",
          decisionId: "recovery-decision-1",
          threadId: "thread-3",
          runId: "run-3",
          executionProfileFingerprint: "c".repeat(64),
          policyRevision: `sha256:${"d".repeat(64)}`,
          allowedOptionIds: ["retry.primary", "terminal.fail"],
          requestedAt: "2026-08-04T12:00:00.000Z",
        },
      },
    },
    responseEnvelope: null,
    responseMessageId: null,
    turnId: "turn-3",
    assistantMessageId: "message-3",
    createdAt: "2026-08-04T12:00:00.000Z",
    resolvedAt: null,
  } satisfies ThreadInteractionView;

  assert.equal(readEvaluationReview(interaction), null);
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
