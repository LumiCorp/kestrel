import assert from "node:assert/strict";
import type { ThreadConversationState } from "@/lib/turns/client-contract";
import {
  collectDurableTurnPresentationParts,
  projectThreadConversation,
} from "@/lib/turns/conversation-projector";
import type { ChatMessage } from "@/lib/types";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const now = "2026-07-15T12:00:00.000Z";

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId?: string
): ChatMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    metadata: turnId ? { kestrelTurnId: turnId } : undefined,
  };
}

function state(): ThreadConversationState {
  return {
    turns: [
      {
        id: "turn-1",
        sequence: 1,
        inputMessageId: "user-1",
        status: "completed",
        failureCode: null,
        failureMessage: null,
        cancelRequestedAt: null,
        startedAt: now,
        finishedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
    interactions: [
      {
        id: "interaction-1",
        requestId: "request-1",
        source: "runtime",
        sourceCheckpointId: null,
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Which workspace?",
        status: "resolved",
        requestEnvelope: {},
        responseEnvelope: { message: "Kestrel" },
        responseMessageId: "user-2",
        turnId: "turn-1",
        assistantMessageId: "assistant-1",
        createdAt: now,
        resolvedAt: now,
      },
    ],
    queue: {
      state: "running",
      pauseReason: null,
      activeTurnId: null,
      version: 4,
    },
  };
}

contractTest("web.hermetic", "wait, reply, and resume project into one durable turn", () => {
  const projection = projectThreadConversation({
    conversationState: state(),
    messages: [
      message("user-1", "user", "Inspect a workspace."),
      message("assistant-1", "assistant", "Which workspace?", "turn-1"),
      message("user-2", "user", "Kestrel"),
      message("assistant-2", "assistant", "Done.", "turn-1"),
    ],
  });

  assert.equal(projection.issues.length, 0);
  assert.equal(projection.items.length, 1);
  const item = projection.items[0];
  assert.equal(item?.kind, "durable_turn");
  if (item?.kind !== "durable_turn") assert.fail("expected durable turn");
  assert.deepEqual(
    item.messages.map((candidate) => candidate.id),
    ["user-1", "assistant-1", "user-2", "assistant-2"]
  );
});

contractTest("web.hermetic", "legacy messages without explicit identities remain standalone", () => {
  const projection = projectThreadConversation({
    conversationState: { ...state(), turns: [], interactions: [] },
    messages: [message("legacy-1", "user", "Old message")],
  });
  assert.deepEqual(
    projection.items.map((item) => item.kind),
    ["standalone_message"]
  );
});

contractTest("web.hermetic", "conflicting explicit identities become visible projection issues", () => {
  const conversationState = state();
  conversationState.turns.push({
    ...conversationState.turns[0]!,
    id: "turn-2",
    sequence: 2,
    inputMessageId: "user-1",
  });
  const projection = projectThreadConversation({
    conversationState,
    messages: [message("user-1", "user", "Conflict")],
  });
  assert.equal(projection.issues[0]?.code, "MESSAGE_TURN_CONFLICT");
});

contractTest("web.hermetic", "historical waiting precedes the resolved interaction in one timeline", () => {
  const assistant = message(
    "assistant-wait",
    "assistant",
    "Which workspace?",
    "turn-1"
  );
  assistant.parts.unshift(
    {
      type: "data-kestrel-interaction",
      id: "interaction:request-1",
      data: {
        version: "v1",
        requestId: "request-1",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Which workspace?",
        source: "runtime",
        status: "resolved",
      },
    },
    {
      type: "data-kestrel-status",
      id: "status:run-wait",
      data: { status: "waiting", runId: "run-wait" },
    }
  );

  assert.deepEqual(
    collectDurableTurnPresentationParts([assistant]).map((part) => part.type),
    ["data-kestrel-status", "data-kestrel-interaction"]
  );
});
