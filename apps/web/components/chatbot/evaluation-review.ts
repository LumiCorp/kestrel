import type { ThreadInteractionView } from "../../lib/turns/client-contract";
import { runnerStructuredReviewOptionLabel } from "@kestrel-agents/protocol";
import { readThreadStructuredReview } from "../../lib/turns/structured-review";

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

export type RecoveryReview = {
  options: Array<{
    id: string;
    label: string;
    description: string;
    kind: "retry" | "terminal" | "alternative";
  }>;
};

export function readEvaluationReview(
  interaction: ThreadInteractionView
): EvaluationReview | null {
  const review = readThreadStructuredReview(interaction);
  if (review.kind !== "structured_review" || review.reason !== "evaluation_review") {
    return null;
  }
  const disclosure = readRecord(review.evaluationTechnicalDisclosure);
  if (disclosure === null || typeof disclosure.candidate !== "string") return null;
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
    allowedOptionIds: [...review.allowedOptionIds],
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
  if (
    optionId !== "evaluation.accept_once" &&
    optionId !== "evaluation.revise" &&
    optionId !== "terminal.fail"
  ) return optionId;
  return runnerStructuredReviewOptionLabel("evaluation_review", optionId);
}

export function readRecoveryReview(
  interaction: ThreadInteractionView
): RecoveryReview | null {
  const review = readRecoveryReviewEnvelope(interaction.requestEnvelope);
  if (review?.reason !== "recovery_review") return null;
  const metadata = review.metadata;
  const allowedOptionIds = review.allowedOptionIds;
  const options = Array.isArray(metadata.recoveryOptions)
    ? metadata.recoveryOptions.flatMap((value) => {
        const option = readRecord(value);
        const kind = option?.kind;
        return option !== null &&
          typeof option.id === "string" &&
          allowedOptionIds.includes(option.id) &&
          typeof option.label === "string" &&
          typeof option.description === "string" &&
          (kind === "retry" || kind === "terminal" || kind === "alternative")
          ? [{
              id: option.id,
              label: option.label,
              description: option.description,
              kind: kind as "retry" | "terminal" | "alternative",
            }]
          : [];
      })
    : [];
  if (
    options.length !== allowedOptionIds.length ||
    new Set(options.map((option) => option.id)).size !== allowedOptionIds.length
  ) {
    return null;
  }
  return { options };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
