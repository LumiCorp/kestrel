import assert from "node:assert/strict";
import type { ThreadConversationState } from "@/lib/turns/client-contract";
import {
  type ComposerSubmissionPolicy,
  getComposerSubmissionPolicy,
} from "@/lib/turns/composer-policy";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


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

function policy(
  conversationState: ThreadConversationState,
  transportStatus: "submitted" | "streaming" | "ready" | "error" = "ready"
): ComposerSubmissionPolicy {
  return getComposerSubmissionPolicy({ conversationState, transportStatus });
}

contractTest("web.hermetic", "answers the exact pending runtime user-input request", () => {
  const interaction: ThreadConversationState["interactions"][number] = {
    id: "interaction-1",
    requestId: "request-1",
    source: "runtime",
    sourceCheckpointId: "checkpoint-1",
    kind: "user_input",
    eventType: "user.reply",
    prompt: "Which city?",
    status: "pending",
    requestEnvelope: {},
    responseEnvelope: null,
    responseMessageId: null,
    turnId: "turn-1",
    assistantMessageId: "assistant-1",
    createdAt: "2026-07-15T12:00:00.000Z",
    resolvedAt: null,
  };
  assert.deepEqual(policy({ ...baseState, interactions: [interaction] }), {
    mode: "answer_interaction",
    interaction,
  });
});

contractTest("web.hermetic", "blocks ordinary messages while approval is pending", () => {
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
    turnId: "turn-2",
    assistantMessageId: "assistant-2",
    createdAt: "2026-07-15T12:00:00.000Z",
    resolvedAt: null,
  };
  assert.equal(
    policy({ ...baseState, interactions: [interaction] }).mode,
    "blocked_interaction"
  );
});

contractTest("web.hermetic", "queues against a durable active turn even when transport is ready", () => {
  assert.deepEqual(
    policy({
      ...baseState,
      turns: [
        {
          id: "turn-3",
          sequence: 3,
          inputMessageId: "message-3",
          status: "running",
          failureCode: null,
          failureMessage: null,
          cancelRequestedAt: null,
          startedAt: "2026-07-15T12:00:00.000Z",
          finishedAt: null,
          createdAt: "2026-07-15T12:00:00.000Z",
          updatedAt: "2026-07-15T12:00:00.000Z",
        },
      ],
      queue: { ...baseState.queue, activeTurnId: "turn-3" },
    }),
    { mode: "queue_turn" }
  );
});

contractTest("web.hermetic", "starts a turn when no durable work or interaction is active", () => {
  assert.deepEqual(policy(baseState), { mode: "start_turn" });
});
