import type { ThreadConversationState } from "@/lib/turns/client-contract";
import {
  type ComposerSubmissionPolicy,
  getComposerSubmissionPolicy,
} from "@/lib/turns/composer-policy";

export type ComposerTransportStatus =
  | "submitted"
  | "streaming"
  | "ready"
  | "error";

export type ComposerPresentationTone =
  | "ready"
  | "working"
  | "attention"
  | "error";

export type ComposerPrimaryActionKind =
  | "send"
  | "queue"
  | "respond"
  | "stop"
  | "blocked"
  | "reset";

export type ComposerPresentation = {
  action: {
    disabled: boolean;
    kind: ComposerPrimaryActionKind;
  };
  label: string;
  submissionPolicy: ComposerSubmissionPolicy;
  tone: ComposerPresentationTone;
};

export function resolveComposerPresentation(input: {
  attachmentCount: number;
  canInterrupt: boolean;
  canQueue: boolean;
  conversationState: ThreadConversationState;
  hasText: boolean;
  transportStatus: ComposerTransportStatus;
  uploadCount: number;
}): ComposerPresentation {
  const submissionPolicy = getComposerSubmissionPolicy({
    conversationState: input.conversationState,
    transportStatus: input.transportStatus,
  });
  const activeTurn = input.conversationState.turns.find(
    (turn) => turn.id === input.conversationState.queue.activeTurnId
  );
  const hasContent = input.hasText || input.attachmentCount > 0;
  const isUploading = input.uploadCount > 0;

  const labelAndTone = resolveLabelAndTone({
    activeTurn,
    conversationState: input.conversationState,
    submissionPolicy,
    transportStatus: input.transportStatus,
  });

  if (input.transportStatus === "error") {
    return {
      ...labelAndTone,
      action: { disabled: false, kind: "reset" },
      submissionPolicy,
    };
  }

  if (activeTurn?.cancelRequestedAt) {
    return {
      ...labelAndTone,
      action: { disabled: true, kind: "stop" },
      submissionPolicy,
    };
  }

  if (submissionPolicy.mode === "blocked_interaction") {
    return {
      ...labelAndTone,
      action: { disabled: true, kind: "blocked" },
      submissionPolicy,
    };
  }

  if (submissionPolicy.mode === "answer_interaction") {
    return {
      ...labelAndTone,
      action: {
        disabled: !input.hasText || input.attachmentCount > 0 || isUploading,
        kind: "respond",
      },
      submissionPolicy,
    };
  }

  if (submissionPolicy.mode === "queue_turn") {
    if (hasContent) {
      return {
        ...labelAndTone,
        action: {
          disabled: isUploading || !input.canQueue,
          kind: "queue",
        },
        submissionPolicy,
      };
    }

    return {
      ...labelAndTone,
      action: {
        disabled: !input.canInterrupt,
        kind: "stop",
      },
      submissionPolicy,
    };
  }

  return {
    ...labelAndTone,
    action: {
      disabled: !hasContent || isUploading,
      kind: "send",
    },
    submissionPolicy,
  };
}

function resolveLabelAndTone(input: {
  activeTurn: ThreadConversationState["turns"][number] | undefined;
  conversationState: ThreadConversationState;
  submissionPolicy: ComposerSubmissionPolicy;
  transportStatus: ComposerTransportStatus;
}): Pick<ComposerPresentation, "label" | "tone"> {
  if (
    input.submissionPolicy.mode === "answer_interaction" ||
    input.submissionPolicy.mode === "blocked_interaction"
  ) {
    const interaction = input.submissionPolicy.interaction;
    return {
      label:
        interaction.kind === "approval" || interaction.kind === "mcp_sampling"
          ? "Waiting for approval"
          : "Waiting for your response",
      tone: "attention",
    };
  }

  if (input.activeTurn?.cancelRequestedAt) {
    return {
      label: "Interrupt requested · stopping at a safe boundary",
      tone: "attention",
    };
  }

  if (input.transportStatus === "error") {
    return { label: "Agent error", tone: "error" };
  }

  if (input.conversationState.queue.pauseReason === "turn_failed") {
    return { label: "Agent failed · queue paused", tone: "error" };
  }

  if (input.conversationState.queue.pauseReason === "turn_cancelled") {
    return { label: "Turn interrupted · queue paused", tone: "attention" };
  }

  if (input.submissionPolicy.mode === "queue_turn") {
    if (input.transportStatus === "submitted") {
      return { label: "Thinking", tone: "working" };
    }
    if (input.transportStatus === "streaming") {
      return { label: "Writing answer", tone: "working" };
    }
    return { label: "Agent working", tone: "working" };
  }

  return { label: "Ready", tone: "ready" };
}
