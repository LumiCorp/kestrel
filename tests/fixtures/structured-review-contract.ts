export const recoveryReviewInteractionFixture = {
  version: "v1",
  requestId: "recovery-review-fixture",
  kind: "user_input",
  eventType: "user.reply",
  prompt: "Kestrel could not continue. Choose one recovery option.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["recoveryOptionId"],
    properties: {
      recoveryOptionId: {
        type: "string",
        enum: ["retry.primary", "terminal.fail"],
      },
    },
  },
  metadata: {
    reason: "recovery_review",
    allowedOptionIds: ["retry.primary", "terminal.fail"],
    triggeringFailureCode: "MODEL_AUTH_ERROR",
    triggeringFailureSummary: "Provider authentication failed after refresh.",
  },
} as const;

export const evaluationReviewInteractionFixture = {
  version: "v1",
  requestId: "evaluation-review-fixture",
  kind: "user_input",
  eventType: "user.reply",
  prompt: "Result requires review.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["recoveryOptionId"],
    properties: {
      recoveryOptionId: {
        type: "string",
        enum: [
          "evaluation.accept_once",
          "evaluation.revise",
          "terminal.fail",
        ],
      },
    },
  },
  metadata: {
    reason: "evaluation_review",
    allowedOptionIds: [
      "evaluation.accept_once",
      "evaluation.revise",
      "terminal.fail",
    ],
    evaluationTechnicalDisclosure: {
      candidate: "Fixture candidate",
      score: 0.6,
      confidence: 0.8,
      assertions: [],
      rationale: "Fixture rationale",
      evidenceReferences: [],
    },
  },
} as const;
