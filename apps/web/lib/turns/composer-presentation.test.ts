import assert from "node:assert/strict";
import { contractTest } from "../../../../tests/helpers/contract-test.js";
import type { ThreadConversationState } from "@/lib/turns/client-contract";
import {
  type ComposerTransportStatus,
  resolveComposerPresentation,
} from "@/lib/turns/composer-presentation";

const baseState: ThreadConversationState = {
  interactions: [],
  turns: [],
  queue: {
    state: "running",
    pauseReason: null,
    activeTurnId: null,
    version: 0,
  },
};

function presentation(input: {
  attachmentCount?: number;
  canInterrupt?: boolean;
  canQueue?: boolean;
  conversationState?: ThreadConversationState;
  hasText?: boolean;
  transportStatus?: ComposerTransportStatus;
  uploadCount?: number;
} = {}) {
  return resolveComposerPresentation({
    attachmentCount: input.attachmentCount ?? 0,
    canInterrupt: input.canInterrupt ?? true,
    canQueue: input.canQueue ?? true,
    conversationState: input.conversationState ?? baseState,
    hasText: input.hasText ?? false,
    transportStatus: input.transportStatus ?? "ready",
    uploadCount: input.uploadCount ?? 0,
  });
}

function activeState(cancelRequestedAt: string | null = null) {
  return {
    ...baseState,
    turns: [
      {
        id: "turn-1",
        sequence: 1,
        inputMessageId: "message-1",
        status: "running" as const,
        failureCode: null,
        failureMessage: null,
        cancelRequestedAt,
        startedAt: "2026-07-21T12:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-07-21T12:00:00.000Z",
        updatedAt: "2026-07-21T12:00:00.000Z",
      },
    ],
    queue: { ...baseState.queue, activeTurnId: "turn-1" },
  } satisfies ThreadConversationState;
}

contractTest("web.hermetic", "idle empty and populated composers resolve disabled and enabled send", () => {
  assert.deepEqual(presentation().action, { disabled: true, kind: "send" });
  assert.deepEqual(presentation({ hasText: true }).action, {
    disabled: false,
    kind: "send",
  });
  assert.deepEqual(presentation({ attachmentCount: 1 }).action, {
    disabled: false,
    kind: "send",
  });
});

contractTest("web.hermetic", "uploads disable an otherwise available send action", () => {
  assert.deepEqual(
    presentation({ hasText: true, uploadCount: 1 }).action,
    { disabled: true, kind: "send" }
  );
});

contractTest("web.hermetic", "active empty composer stops and active draft queues", () => {
  const conversationState = activeState();
  assert.deepEqual(presentation({ conversationState }).action, {
    disabled: false,
    kind: "stop",
  });
  assert.deepEqual(
    presentation({ conversationState, hasText: true }).action,
    { disabled: false, kind: "queue" }
  );
  assert.deepEqual(
    presentation({ attachmentCount: 1, conversationState }).action,
    { disabled: false, kind: "queue" }
  );
});

contractTest("web.hermetic", "queue capability and uploads disable queue submission", () => {
  const conversationState = activeState();
  assert.equal(
    presentation({ conversationState, hasText: true, canQueue: false }).action
      .disabled,
    true
  );
  assert.equal(
    presentation({ conversationState, hasText: true, uploadCount: 1 }).action
      .disabled,
    true
  );
});

contractTest("web.hermetic", "a recorded cancellation locks the stop action", () => {
  assert.deepEqual(
    presentation({
      conversationState: activeState("2026-07-21T12:01:00.000Z"),
      hasText: true,
    }).action,
    { disabled: true, kind: "stop" }
  );
});

contractTest("web.hermetic", "runtime user input resolves an exact response action", () => {
  const interaction: ThreadConversationState["interactions"][number] = {
    id: "interaction-1",
    requestId: "request-1",
    source: "runtime",
    sourceCheckpointId: "checkpoint-1",
    kind: "user_input",
    eventType: "user.reply",
    prompt: "Which workspace?",
    status: "pending",
    requestEnvelope: {},
    responseEnvelope: null,
    responseMessageId: null,
    turnId: "turn-1",
    assistantMessageId: "assistant-1",
    createdAt: "2026-07-21T12:00:00.000Z",
    resolvedAt: null,
  };
  const conversationState = { ...baseState, interactions: [interaction] };

  assert.deepEqual(
    presentation({ conversationState, hasText: true }).action,
    { disabled: false, kind: "respond" }
  );
  assert.equal(
    presentation({ attachmentCount: 1, conversationState, hasText: true })
      .action.disabled,
    true
  );
});

contractTest("web.hermetic", "approval blocks the composer with an attention state", () => {
  const interaction: ThreadConversationState["interactions"][number] = {
    id: "interaction-2",
    requestId: "request-2",
    source: "runtime",
    sourceCheckpointId: "checkpoint-2",
    kind: "approval",
    eventType: "approval.reply",
    prompt: "Approve deployment?",
    status: "pending",
    requestEnvelope: {},
    responseEnvelope: null,
    responseMessageId: null,
    turnId: "turn-1",
    assistantMessageId: "assistant-1",
    createdAt: "2026-07-21T12:00:00.000Z",
    resolvedAt: null,
  };
  const result = presentation({
    conversationState: { ...baseState, interactions: [interaction] },
  });

  assert.deepEqual(result.action, { disabled: true, kind: "blocked" });
  assert.equal(result.tone, "attention");
});

contractTest("web.hermetic", "transport errors expose reset and ready recovery restores send", () => {
  assert.deepEqual(presentation({ transportStatus: "error" }).action, {
    disabled: false,
    kind: "reset",
  });
  assert.equal(presentation({ transportStatus: "error" }).tone, "error");
  assert.deepEqual(presentation({ transportStatus: "ready" }).action, {
    disabled: true,
    kind: "send",
  });
});
