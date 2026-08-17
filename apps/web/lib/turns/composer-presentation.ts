import { resolveConversationComposerPresentation } from "@kestrel-agents/conversation";
import type { ThreadConversationState } from "@/lib/turns/client-contract";
import type { ComposerSubmissionPolicy } from "@/lib/turns/composer-policy";
import { readThreadStructuredReview } from "@/lib/turns/structured-review";

export type ComposerTransportStatus = "submitted" | "streaming" | "ready" | "error";
export type ComposerPresentationTone = "ready" | "working" | "attention" | "error";
export type ComposerPrimaryActionKind = "send" | "queue" | "respond" | "stop" | "blocked" | "reset";

export type ComposerPresentation = {
  action: { disabled: boolean; kind: ComposerPrimaryActionKind };
  label: string;
  submissionPolicy: ComposerSubmissionPolicy;
  tone: ComposerPresentationTone;
};

export function isComposerPrimaryActionBlockedBySetup(
  actionKind: ComposerPrimaryActionKind,
  setupBlocked: boolean,
) {
  return setupBlocked && (actionKind === "send" || actionKind === "queue");
}

export function resolveComposerPresentation(input: {
  attachmentCount: number;
  canInterrupt: boolean;
  canQueue: boolean;
  conversationState: ThreadConversationState;
  hasText: boolean;
  transportStatus: ComposerTransportStatus;
  uploadCount: number;
}): ComposerPresentation {
  return resolveConversationComposerPresentation({
    turns: input.conversationState.turns,
    interactions: input.conversationState.interactions,
    queue: input.conversationState.queue,
    transportStatus: input.transportStatus,
    hasText: input.hasText,
    attachmentCount: input.attachmentCount,
    uploadCount: input.uploadCount,
    canQueue: input.canQueue,
    canInterrupt: input.canInterrupt,
    isInteractionBlocked: (interaction) => {
      const review = readThreadStructuredReview(
        interaction as ThreadConversationState["interactions"][number],
      );
      return review.kind === "structured_review" || review.kind === "invalid_review";
    },
  }) as ComposerPresentation;
}
