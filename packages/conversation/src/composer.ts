import type {
  ConversationInteraction,
  ConversationMode,
  ConversationModeSwitchPresentation,
  ConversationQueueState,
  ConversationTurn,
} from "./contracts.js";

const MODE_BLOCK_REASONS = new Set([
  "route_mode_blocked",
  "planner_mode_blocked",
  "acter_mode_blocked",
]);

export type ConversationComposerPolicy =
  | { mode: "answer_interaction"; interaction: ConversationInteraction }
  | { mode: "blocked_interaction"; interaction: ConversationInteraction }
  | { mode: "queue_turn" }
  | { mode: "start_turn" };

export type ConversationComposerAction = "send" | "queue" | "respond" | "stop" | "blocked" | "reset";
export type ConversationComposerKeyboardAction = "submit" | "newline" | "none";

export interface ConversationComposerPresentation {
  action: { disabled: boolean; kind: ConversationComposerAction };
  label: string;
  tone: "ready" | "working" | "attention" | "error";
  submissionPolicy: ConversationComposerPolicy;
}

export function resolveConversationComposerPolicy(input: {
  turns: readonly ConversationTurn[];
  interactions: readonly ConversationInteraction[];
  queue: ConversationQueueState;
  transportStatus: "submitted" | "streaming" | "ready" | "error";
  isInteractionBlocked?: ((interaction: ConversationInteraction) => boolean) | undefined;
}): ConversationComposerPolicy {
  const pending = input.interactions.find((interaction) => interaction.status === "pending");
  if (pending) {
    if (input.isInteractionBlocked?.(pending) === true) {
      return { mode: "blocked_interaction", interaction: pending };
    }
    return pending.source === "runtime" && pending.kind === "user_input"
      ? { mode: "answer_interaction", interaction: pending }
      : { mode: "blocked_interaction", interaction: pending };
  }
  const active = input.turns.find((turn) => turn.id === input.queue.activeTurnId);
  return input.transportStatus === "submitted" || input.transportStatus === "streaming" || active?.status === "queued" || active?.status === "running"
    ? { mode: "queue_turn" }
    : { mode: "start_turn" };
}

export function resolveConversationComposerPresentation(input: {
  turns: readonly ConversationTurn[];
  interactions: readonly ConversationInteraction[];
  queue: ConversationQueueState;
  transportStatus: "submitted" | "streaming" | "ready" | "error";
  hasText: boolean;
  attachmentCount: number;
  uploadCount: number;
  canQueue: boolean;
  canInterrupt: boolean;
  isInteractionBlocked?: ((interaction: ConversationInteraction) => boolean) | undefined;
}): ConversationComposerPresentation {
  const submissionPolicy = resolveConversationComposerPolicy(input);
  const active = input.turns.find((turn) => turn.id === input.queue.activeTurnId);
  const hasContent = input.hasText || input.attachmentCount > 0;
  const uploading = input.uploadCount > 0;
  const status = labelAndTone(input, submissionPolicy, active);
  if (input.transportStatus === "error") return { ...status, action: { disabled: false, kind: "reset" }, submissionPolicy };
  if (active?.cancelRequestedAt) return { ...status, action: { disabled: true, kind: "stop" }, submissionPolicy };
  if (submissionPolicy.mode === "blocked_interaction") return { ...status, action: { disabled: true, kind: "blocked" }, submissionPolicy };
  if (submissionPolicy.mode === "answer_interaction") {
    return { ...status, action: { disabled: !input.hasText || input.attachmentCount > 0 || uploading, kind: "respond" }, submissionPolicy };
  }
  if (submissionPolicy.mode === "queue_turn") {
    return hasContent
      ? { ...status, action: { disabled: uploading || !input.canQueue, kind: "queue" }, submissionPolicy }
      : { ...status, action: { disabled: !input.canInterrupt, kind: "stop" }, submissionPolicy };
  }
  return { ...status, action: { disabled: !hasContent || uploading, kind: "send" }, submissionPolicy };
}

export function resolveConversationComposerKeyboardAction(input: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}): ConversationComposerKeyboardAction {
  if (input.key !== "Enter") return "none";
  if (input.isComposing || input.altKey || input.ctrlKey || input.metaKey) return "none";
  return input.shiftKey ? "newline" : "submit";
}

export function createModeSwitchRetryGuard() {
  const accepted = new Set<string>();
  return {
    has(recommendationId: string) {
      return accepted.has(recommendationId);
    },
    async run<Result>(input: {
      recommendationId: string;
      mode: ConversationMode;
      switchMode: (mode: ConversationMode) => void | Promise<void>;
      retry: () => Promise<Result>;
    }): Promise<Result | undefined> {
      if (accepted.has(input.recommendationId)) return;
      accepted.add(input.recommendationId);
      try {
        await input.switchMode(input.mode);
        return await input.retry();
      } catch (error) {
        accepted.delete(input.recommendationId);
        throw error;
      }
    },
  };
}

/**
 * Converts the runtime's explicit mode-blocked wait contract into a typed
 * presentation action. Unknown reasons are rejected rather than guessed.
 */
export function resolveConversationModeSwitch(input: {
  recommendationId: string;
  originatingMessageId: string;
  fromMode: ConversationMode;
  reason: string;
  metadata: Readonly<Record<string, unknown>> | undefined;
}): ConversationModeSwitchPresentation | undefined {
  if (
    readNonEmptyString(input.recommendationId) === undefined
    || readNonEmptyString(input.originatingMessageId) === undefined
  ) return;
  const blockReason = readNonEmptyString(input.metadata?.reason);
  if (blockReason === undefined || !MODE_BLOCK_REASONS.has(blockReason)) return;
  const requiredToolClass = readNonEmptyString(input.metadata?.requiredToolClass);
  if (
    requiredToolClass !== "read_only" &&
    requiredToolClass !== "planning_write" &&
    requiredToolClass !== "sandboxed_only" &&
    requiredToolClass !== "external_side_effect"
  ) return;
  return {
    version: "v1",
    recommendationId: input.recommendationId,
    fromMode: input.fromMode,
    toMode:
      requiredToolClass === "read_only" || requiredToolClass === "planning_write"
        ? "plan"
        : "build",
    reason: input.reason,
    originatingMessageId: input.originatingMessageId,
    status: "pending",
  };
}

function labelAndTone(
  input: {
    queue: ConversationQueueState;
    transportStatus: "submitted" | "streaming" | "ready" | "error";
  },
  policy: ConversationComposerPolicy,
  active: ConversationTurn | undefined,
) {
  if (policy.mode === "answer_interaction" || policy.mode === "blocked_interaction") {
    return { label: policy.interaction.kind === "approval" || policy.interaction.kind === "mcp_sampling" ? "Waiting for approval" : "Waiting for your response", tone: "attention" as const };
  }
  if (active?.cancelRequestedAt) return { label: "Interrupt requested · stopping at a safe boundary", tone: "attention" as const };
  if (input.transportStatus === "error") return { label: "Connection error · reset to continue", tone: "error" as const };
  if (input.queue.pauseReason === "turn_failed") return { label: "Agent failed · send a new message to continue", tone: "error" as const };
  if (input.queue.pauseReason === "turn_cancelled") return { label: "Turn interrupted · send a new message to continue", tone: "attention" as const };
  if (policy.mode === "queue_turn") {
    return { label: input.transportStatus === "submitted" ? "Thinking" : input.transportStatus === "streaming" ? "Writing answer" : "Agent working", tone: "working" as const };
  }
  return { label: "Ready", tone: "ready" as const };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
