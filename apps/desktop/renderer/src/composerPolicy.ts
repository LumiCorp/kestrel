import type { DesktopOperatorInboxItem } from "../../src/contracts";

export type DesktopComposerSubmissionPolicy =
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
    return { mode: "reply_to_request", item: request };
  }
  return input.runActive ? { mode: "queue_follow_up" } : { mode: "start_turn" };
}
