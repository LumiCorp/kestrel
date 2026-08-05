import type { DesktopOperatorInboxItem } from "../../src/contracts";

export type DesktopComposerSubmissionPolicy =
  | {
      mode: "select_recovery_option";
      item: DesktopOperatorInboxItem & { requestId: string };
      allowedOptionIds: string[];
      reviewKind: "recovery" | "evaluation";
      triggeringFailureCode?: string | undefined;
      triggeringFailureSummary?: string | undefined;
      evaluationTechnicalDisclosure?: Record<string, unknown> | undefined;
    }
  | {
      mode: "reply_to_request";
      item: DesktopOperatorInboxItem & { requestId: string };
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
    const metadata = request.metadata;
    if (
      metadata?.reason === "recovery_review" ||
      metadata?.reason === "evaluation_review"
    ) {
      const allowedOptionIds = Array.isArray(metadata.allowedOptionIds)
        ? metadata.allowedOptionIds.filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
        : [];
      const triggeringFailureCode =
        typeof metadata.triggeringFailureCode === "string" &&
        metadata.triggeringFailureCode.trim().length > 0
          ? metadata.triggeringFailureCode
          : undefined;
      const triggeringFailureSummary =
        typeof metadata.triggeringFailureSummary === "string" &&
        metadata.triggeringFailureSummary.trim().length > 0
          ? metadata.triggeringFailureSummary.trim()
          : undefined;
      return {
        mode: "select_recovery_option",
        item: request,
        allowedOptionIds,
        reviewKind:
          metadata.reason === "evaluation_review" ? "evaluation" : "recovery",
        ...(triggeringFailureCode !== undefined ? { triggeringFailureCode } : {}),
        ...(triggeringFailureSummary !== undefined
          ? { triggeringFailureSummary }
          : {}),
        ...(isRecord(metadata.evaluationTechnicalDisclosure)
          ? {
              evaluationTechnicalDisclosure:
                metadata.evaluationTechnicalDisclosure,
            }
          : {}),
      };
    }
    return { mode: "reply_to_request", item: request };
  }
  return input.runActive ? { mode: "queue_follow_up" } : { mode: "start_turn" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
