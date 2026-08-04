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
