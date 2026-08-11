import type { ThreadConversationState } from "@/lib/turns/client-contract";
import {
  isRecoveryReviewRequest,
  readRecoveryReviewEnvelope,
} from "@/lib/turns/recovery-review";

type ChatTransportStatus = "submitted" | "streaming" | "ready" | "error";

export type ComposerSubmissionPolicy =
  | {
      mode: "select_recovery_option";
      interaction: ThreadConversationState["interactions"][number];
      allowedOptionIds: string[];
    }
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
  const pendingInteraction = input.conversationState.interactions.find(
    (interaction) => interaction.status === "pending"
  );
  if (pendingInteraction) {
    const review = readRecoveryReviewEnvelope(pendingInteraction.requestEnvelope);
    if (
      pendingInteraction.source === "runtime" &&
      pendingInteraction.kind === "user_input" &&
      review !== null &&
      review.bindingId === pendingInteraction.requestId
    ) {
      return {
        mode: "select_recovery_option",
        interaction: pendingInteraction,
        allowedOptionIds: review.allowedOptionIds,
      };
    }
    if (
      pendingInteraction.source === "runtime" &&
      isRecoveryReviewRequest(pendingInteraction.requestEnvelope)
    ) {
      return { mode: "blocked_interaction", interaction: pendingInteraction };
    }
    if (
      pendingInteraction.source === "runtime" &&
      pendingInteraction.kind === "user_input"
    ) {
      return { mode: "answer_interaction", interaction: pendingInteraction };
    }
    return { mode: "blocked_interaction", interaction: pendingInteraction };
  }

  const activeTurn = input.conversationState.turns.find(
    (turn) => turn.id === input.conversationState.queue.activeTurnId
  );
  if (
    input.transportStatus === "submitted" ||
    input.transportStatus === "streaming" ||
    activeTurn?.status === "queued" ||
    activeTurn?.status === "running"
  ) {
    return { mode: "queue_turn" };
  }

  return { mode: "start_turn" };
}
