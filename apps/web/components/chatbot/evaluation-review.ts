import type { ThreadInteractionView } from "../../lib/turns/client-contract";
import {
  readRecoveryReviewEnvelope,
  recoveryOptionLabel,
} from "../../lib/turns/recovery-review";

export type EvaluationReview = {
  allowedOptionIds: string[];
  candidate: string;
  score?: number | undefined;
  confidence?: number | undefined;
  rationale?: string | undefined;
  assertions: Array<{
    assertionId: string;
    passed: boolean;
    rationale?: string | undefined;
  }>;
  evidenceReferences: string[];
};

export function readEvaluationReview(
  interaction: ThreadInteractionView
): EvaluationReview | null {
  const review = readRecoveryReviewEnvelope(interaction.requestEnvelope);
  if (review?.reason !== "evaluation_review") return null;
  const metadata = review.metadata;
  const disclosure = readRecord(metadata.evaluationTechnicalDisclosure);
  if (disclosure === null || typeof disclosure.candidate !== "string") return null;
  const allowedOptionIds = review.allowedOptionIds;
  if (allowedOptionIds.length === 0) return null;
  const assertions = Array.isArray(disclosure.assertions)
    ? disclosure.assertions.flatMap((value) => {
        const assertion = readRecord(value);
        return assertion !== null &&
          typeof assertion.assertionId === "string" &&
          typeof assertion.passed === "boolean"
          ? [{
              assertionId: assertion.assertionId,
              passed: assertion.passed,
              ...(typeof assertion.rationale === "string"
                ? { rationale: assertion.rationale }
                : {}),
            }]
          : [];
      })
    : [];
  return {
    allowedOptionIds,
    candidate: disclosure.candidate,
    ...(typeof disclosure.score === "number" ? { score: disclosure.score } : {}),
    ...(typeof disclosure.confidence === "number"
      ? { confidence: disclosure.confidence }
      : {}),
    ...(typeof disclosure.rationale === "string"
      ? { rationale: disclosure.rationale }
      : {}),
    assertions,
    evidenceReferences: Array.isArray(disclosure.evidenceReferences)
      ? disclosure.evidenceReferences.filter(
          (value): value is string => typeof value === "string"
        )
      : [],
  };
}

export function evaluationOptionLabel(optionId: string): string {
  return recoveryOptionLabel(optionId);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
