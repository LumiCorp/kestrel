import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@/lib/types";
import { getTextFromMessage } from "@/lib/utils";
import {
  reconcileConversationMessages,
  removeDurableQueuedMessages,
} from "./message-reconciliation";

function message(input: {
  id: string;
  text: string;
  role?: "user" | "assistant";
  turnId?: string;
  deliveryState?: "sending" | "queued";
}): ChatMessage {
  return {
    id: input.id,
    role: input.role ?? "assistant",
    parts: [{ type: "text", text: input.text }],
    metadata: {
      ...(input.turnId ? { kestrelTurnId: input.turnId } : {}),
      ...(input.deliveryState ? { deliveryState: input.deliveryState } : {}),
    },
  };
}

test("persisted refresh preserves a running stream and owns waiting or terminal turns", () => {
  const runningPersisted = message({
    id: "running-assistant",
    text: "old",
    turnId: "running-turn",
  });
  const runningLive = message({
    id: "running-assistant",
    text: "streaming now",
    turnId: "running-turn",
  });
  const waitingPersisted = message({
    id: "waiting-assistant",
    text: "Which workspace?",
    turnId: "waiting-turn",
  });
  const waitingLive = message({
    id: "waiting-assistant",
    text: "partial question",
    turnId: "waiting-turn",
  });
  const staleTerminalSegment = message({
    id: "stale-terminal-segment",
    text: "partial final",
    turnId: "completed-turn",
  });

  const reconciled = reconcileConversationMessages({
    persistedMessages: [runningPersisted, waitingPersisted],
    liveMessages: [runningLive, waitingLive, staleTerminalSegment],
    turns: [
      {
        id: "running-turn",
        sequence: 1,
        inputMessageId: null,
        status: "running",
        failureCode: null,
        failureMessage: null,
        cancelRequestedAt: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "waiting-turn",
        sequence: 2,
        inputMessageId: null,
        status: "waiting_for_input",
        failureCode: null,
        failureMessage: null,
        cancelRequestedAt: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "completed-turn",
        sequence: 3,
        inputMessageId: null,
        status: "completed",
        failureCode: null,
        failureMessage: null,
        cancelRequestedAt: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });

  assert.equal(
    getTextFromMessage(
      reconciled.find((item) => item.id === "running-assistant")!,
    ),
    "streaming now",
  );
  assert.equal(
    getTextFromMessage(
      reconciled.find((item) => item.id === "waiting-assistant")!,
    ),
    "Which workspace?",
  );
  assert.equal(
    reconciled.some((item) => item.id === staleTerminalSegment.id),
    false,
  );
});

test("durable message IDs remove optimistic queued copies exactly once", () => {
  const queued = message({
    id: "queued-user",
    role: "user",
    text: "next",
    deliveryState: "queued",
  });
  assert.deepEqual(
    removeDurableQueuedMessages({
      queuedMessages: [{ message: queued, turnId: "turn-2" }],
      persistedMessages: [message({ id: queued.id, role: "user", text: "next" })],
    }),
    [],
  );
});
