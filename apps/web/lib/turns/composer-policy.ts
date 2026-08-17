import type { ThreadConversationState } from "@/lib/turns/client-contract";
import { readThreadStructuredReview } from "@/lib/turns/structured-review";
import { resolveConversationComposerPolicy } from "@kestrel-agents/conversation";

type ChatTransportStatus = "submitted" | "streaming" | "ready" | "error";

export type ComposerSubmissionPolicy =
  | {
      mode: "answer_interaction";
      interaction: ThreadConversationState["interactions"][number];
    }
  | {
      mode: "blocked_interaction";
      interaction: ThreadConversationState["interactions"][number];
    }
  | { mode: "queue_turn" }
  | { mode: "start_turn" };

/**
 * Resolves composer behavior from durable conversation state. The transport
 * status is only a live hint; persisted turns and interactions remain the
 * source of truth across reloads.
 */
export function getComposerSubmissionPolicy(input: {
  conversationState: ThreadConversationState;
  transportStatus: ChatTransportStatus;
}): ComposerSubmissionPolicy {
  return resolveConversationComposerPolicy({
    turns: input.conversationState.turns,
    interactions: input.conversationState.interactions,
    queue: input.conversationState.queue,
    transportStatus: input.transportStatus,
    isInteractionBlocked: (interaction) => {
      const review = readThreadStructuredReview(
        interaction as ThreadConversationState["interactions"][number],
      );
      return review.kind === "structured_review" || review.kind === "invalid_review";
    },
  }) as ComposerSubmissionPolicy;
}
