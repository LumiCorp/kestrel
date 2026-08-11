import type { DesktopOperatorInboxItem } from "../../src/contracts";
import {
  parseRunnerStructuredReviewInteractionV1,
  type RunnerStructuredReviewClassificationV1,
  type RunnerStructuredReviewOptionId,
} from "@kestrel-agents/protocol";

export type DesktopComposerSubmissionPolicy =
  | {
      mode: "select_evaluation_option";
      item: DesktopOperatorInboxItem & { requestId: string };
      allowedOptionIds: RunnerStructuredReviewOptionId[];
      evaluationTechnicalDisclosure?: Record<string, unknown> | undefined;
    }
  | {
      mode: "reply_to_request";
      item: DesktopOperatorInboxItem & { requestId: string };
    }
  | {
      mode: "invalid_review";
      item: DesktopOperatorInboxItem & { requestId: string };
      error: string;
    }
  | { mode: "queue_follow_up" }
  | { mode: "start_turn" };

/**
 * Durable operator state takes precedence over transient runner activity. A
 * user-input request is answered through the standard composer instead of a
 * second input rendered inside its action card.
 */
export function getDesktopComposerSubmissionPolicy(input: {
  inboxItems: readonly DesktopOperatorInboxItem[];
  runActive: boolean;
}): DesktopComposerSubmissionPolicy {
  const request = input.inboxItems.find(
    (item): item is DesktopOperatorInboxItem & { requestId: string } =>
      item.kind === "user_input_request"
      && item.actionable !== false
      && item.requestId !== undefined,
  );
  if (request !== undefined) {
    const review = classifyDesktopReview(request);
    if (review.kind === "invalid_review") {
      return { mode: "invalid_review", item: request, error: review.error };
    }
    if (review.kind === "structured_review") {
      return {
        mode: "select_evaluation_option",
        item: request,
        allowedOptionIds: [...review.allowedOptionIds],
        ...(review.evaluationTechnicalDisclosure !== undefined
          ? { evaluationTechnicalDisclosure: review.evaluationTechnicalDisclosure }
          : {}),
      };
    }
    return { mode: "reply_to_request", item: request };
  }
  return input.runActive ? { mode: "queue_follow_up" } : { mode: "start_turn" };
}

function classifyDesktopReview(
  request: DesktopOperatorInboxItem,
): RunnerStructuredReviewClassificationV1 {
  if (request.interaction !== undefined) {
    return parseRunnerStructuredReviewInteractionV1(request.interaction);
  }
  if (
    request.metadata?.reason === "recovery_review" ||
    request.metadata?.reason === "evaluation_review"
  ) {
    return {
      kind: "invalid_review",
      reason: request.metadata.reason,
      error: "This request cannot be answered safely because its interaction contract is missing.",
    };
  }
  return { kind: "ordinary" };
}
