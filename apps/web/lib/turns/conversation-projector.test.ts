import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldInstallThreadConversationSnapshot,
  type ThreadConversationSnapshot,
  type ThreadConversationState,
} from "@/lib/turns/client-contract";
import {
  collectDurableTurnPresentationParts,
  projectThreadConversation,
} from "@/lib/turns/conversation-projector";
import type { ChatMessage } from "@/lib/types";
import {
  conversationConformanceFixture,
  conversationProjectionConformanceScenarios,
  normalizeConversationConformanceProjection,
  normalizeConversationProjectionConformance,
} from "@kestrel-agents/conversation";


const now = "2026-07-15T12:00:00.000Z";

test("Kestrel One installs equal or newer snapshots but rejects stale queue versions", () => {
  const snapshot = (version: number): ThreadConversationSnapshot => ({
    messages: [],
    interactions: [],
    turns: [],
    queue: { state: "running", pauseReason: null, activeTurnId: null, version },
  });
  assert.equal(shouldInstallThreadConversationSnapshot(snapshot(4), snapshot(4)), true);
  assert.equal(shouldInstallThreadConversationSnapshot(snapshot(4), snapshot(5)), true);
  assert.equal(shouldInstallThreadConversationSnapshot(snapshot(5), snapshot(4)), false);
  assert.equal(shouldInstallThreadConversationSnapshot(snapshot(4), snapshot(4), {
    requestedThreadId: "thread-1",
    activeThreadId: "thread-1",
    requestSequence: 3,
    lastInstalledSequence: 4,
  }), false);
  assert.equal(shouldInstallThreadConversationSnapshot(snapshot(4), snapshot(4), {
    requestedThreadId: "thread-1",
    activeThreadId: "thread-1",
    requestSequence: 5,
    lastInstalledSequence: 4,
  }), true);
  assert.equal(shouldInstallThreadConversationSnapshot(snapshot(4), snapshot(8), {
    requestedThreadId: "thread-1",
    activeThreadId: "thread-2",
    requestSequence: 6,
    lastInstalledSequence: 4,
  }), false);
});

test("Kestrel One projects the shared conformance fixture by durable identity", () => {
  const fixture = conversationConformanceFixture;
  const projection = projectThreadConversation({
    conversationState: {
      turns: fixture.turns.map((turn) => ({
        id: turn.id,
        sequence: turn.sequence,
        inputMessageId: turn.inputMessageId,
        status: turn.status,
        failureCode: null,
        failureMessage: null,
        cancelRequestedAt: null,
        startedAt: now,
        finishedAt: turn.status === "completed" ? now : null,
        createdAt: now,
        updatedAt: now,
      })),
      interactions: [],
      queue: {
        state: "running",
        pauseReason: null,
        activeTurnId: "turn-2",
        version: 1,
      },
    },
    messages: fixture.messages.map((entry) =>
      message(
        entry.id,
        entry.role,
        entry.text,
        "turnId" in entry ? entry.turnId : undefined,
      )
    ),
  });

  assert.deepEqual(
    normalizeConversationConformanceProjection(projection),
    fixture.expected,
  );
});

test("Kestrel One normalizes every shared projection conformance scenario", () => {
  for (const fixture of conversationProjectionConformanceScenarios) {
    const projection = projectThreadConversation({
      conversationState: {
        turns: fixture.turns.map((turn) => ({
          ...turn,
          sequence: turn.sequence ?? 0,
          failureCode: turn.failureCode ?? null,
          failureMessage: turn.failureMessage ?? null,
          cancelRequestedAt: turn.cancelRequestedAt ?? null,
          startedAt: turn.startedAt ?? null,
          finishedAt: turn.finishedAt ?? null,
        })),
        interactions: fixture.interactions.map((interaction) => ({
          ...interaction,
          sourceCheckpointId: null,
          requestEnvelope: interaction.requestEnvelope ?? {},
          responseEnvelope: interaction.responseEnvelope ?? null,
          resolvedAt: interaction.resolvedAt ?? null,
        })),
        queue: fixture.queue,
      },
      messages: fixture.messages.map((entry) => ({
        id: entry.id,
        role: entry.role,
        parts: [{ type: "text" as const, text: entry.id }],
        ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      } as ChatMessage)),
    });
    assert.deepEqual(
      normalizeConversationProjectionConformance(projection),
      fixture.expected,
      fixture.name,
    );
  }
});

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

test("wait, reply, and resume project into one durable turn", () => {
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

test("legacy messages without explicit identities remain standalone", () => {
  const projection = projectThreadConversation({
    conversationState: { ...state(), turns: [], interactions: [] },
    messages: [message("legacy-1", "user", "Old message")],
  });
  assert.deepEqual(
    projection.items.map((item) => item.kind),
    ["standalone_message"]
  );
});

test("conflicting explicit identities become visible projection issues", () => {
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

for (const status of [
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
] as const) {
  test(`a ${status} durable turn no longer presents its input as queued`, () => {
    const conversationState = state();
    conversationState.turns[0] = {
      ...conversationState.turns[0]!,
      status,
      finishedAt:
        status === "completed" || status === "failed" || status === "cancelled"
          ? now
          : null,
    };
    const queuedInput = message("user-1", "user", "Inspect a workspace.");
    queuedInput.metadata = {
      deliveryState: "queued",
      kestrelTurnId: "turn-1",
    };

    const projection = projectThreadConversation({
      conversationState,
      messages: [queuedInput],
    });
    const item = projection.items[0];

    assert.equal(item?.kind, "durable_turn");
    if (item?.kind !== "durable_turn") assert.fail("expected durable turn");
    assert.equal(item.messages[0]?.metadata?.deliveryState, undefined);
    assert.equal(item.messages[0]?.metadata?.kestrelTurnId, "turn-1");
  });
}

test("a queued durable turn retains its queued delivery state", () => {
  const conversationState = state();
  conversationState.turns[0] = {
    ...conversationState.turns[0]!,
    status: "queued",
    finishedAt: null,
    startedAt: null,
  };
  const queuedInput = message("user-1", "user", "Inspect a workspace.");
  queuedInput.metadata = {
    deliveryState: "queued",
    kestrelTurnId: "turn-1",
  };

  const projection = projectThreadConversation({
    conversationState,
    messages: [queuedInput],
  });
  const item = projection.items[0];

  assert.equal(item?.kind, "durable_turn");
  if (item?.kind !== "durable_turn") assert.fail("expected durable turn");
  assert.equal(item.messages[0]?.metadata?.deliveryState, "queued");
});

test("historical waiting precedes the resolved interaction in one timeline", () => {
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
