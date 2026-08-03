import type { DesktopOperatorInboxItem } from "../../src/contracts";

export type DesktopComposerSubmissionPolicy =
  | {
      mode: "select_recovery_option";
      item: DesktopOperatorInboxItem & { requestId: string };
      allowedOptionIds: string[];
      triggeringFailureCode?: string | undefined;
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
    if (metadata?.reason === "recovery_review") {
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
      return {
        mode: "select_recovery_option",
        item: request,
        allowedOptionIds,
        ...(triggeringFailureCode !== undefined ? { triggeringFailureCode } : {}),
      };
    }
    return { mode: "reply_to_request", item: request };
  }
  return input.runActive ? { mode: "queue_follow_up" } : { mode: "start_turn" };
}
