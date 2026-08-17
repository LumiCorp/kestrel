import test from "node:test";
import assert from "node:assert/strict";

import {
  createModeSwitchRetryGuard,
  describeConversationLink,
  resolveConversationModeSwitch,
  projectConversation,
  reconcileConversationMessages,
  reduceConversationActivity,
  resolveConversationComposerKeyboardAction,
  resolveConversationComposerPresentation,
  type ConversationInteraction,
  type ConversationMessageLike,
  type ConversationTurn,
} from "../src/index.js";

const createdAt = "2026-08-13T12:00:00.000Z";

test("projects durable turns by identity instead of message position", () => {
  const turns = [turn("turn-2", 2, "user-2"), turn("turn-1", 1, "user-1")];
  const messages: ConversationMessageLike[] = [
    message("assistant-2", "assistant", "turn-2"),
    message("user-1", "user"),
    message("assistant-1", "assistant", "turn-1"),
    message("user-2", "user"),
  ];
  const projected = projectConversation({ messages, turns, interactions: [] });
  assert.deepEqual(projected.items.map((item) => item.kind === "durable_turn" ? [item.turnId, item.messages.map((entry) => entry.id)] : []), [
    ["turn-1", ["user-1", "assistant-1"]],
    ["turn-2", ["user-2", "assistant-2"]],
  ]);
});

test("reports conflicting explicit message ownership", () => {
  const interactions: ConversationInteraction[] = [{
    id: "interaction-1",
    requestId: "request-1",
    source: "runtime",
    kind: "user_input",
    eventType: "user.input",
    prompt: "Continue?",
    status: "pending",
    turnId: "turn-2",
    assistantMessageId: "assistant-1",
    responseMessageId: null,
    createdAt,
  }];
  const projected = projectConversation({
    messages: [message("assistant-1", "assistant", "turn-1")],
    turns: [turn("turn-1", 1, "user-1"), turn("turn-2", 2, "user-2")],
    interactions,
  });
  assert.equal(projected.issues[0]?.code, "MESSAGE_TURN_CONFLICT");
});

test("terminal persisted messages replace stale live messages", () => {
  const turns = [{ ...turn("turn-1", 1, "user-1"), status: "completed" as const }];
  const persisted = [{ ...message("assistant-1", "assistant", "turn-1"), value: "final" }];
  const live = [{ ...message("assistant-1", "assistant", "turn-1"), value: "partial" }];
  assert.equal(reconcileConversationMessages({ persistedMessages: persisted, liveMessages: live, turns })[0]?.value, "final");
});

test("interleaved reasoning formats update one reasoning stream", () => {
  const events = [
    runtimeEvent("run.model.reasoning.started", { attempt: 1, format: "summary", contentState: "live" }),
    runtimeEvent("run.model.reasoning.delta", { attempt: 1, format: "summary", contentState: "live", delta: "Inspecting " }),
    runtimeEvent("run.agent_progress", { message: "Still working.", stepAgent: "agent.loop" }),
    runtimeEvent("run.model.reasoning.delta", { attempt: 1, format: "provider_reasoning_text", contentState: "live", delta: "the workspace." }),
  ];
  const result = events.reduce(reduceConversationActivity, []);
  assert.equal(result.filter((item) => item.kind === "reasoning").length, 1);
  assert.equal(result.find((item) => item.kind === "reasoning")?.text, "Inspecting the workspace.");
});

test("composer queues content during active work", () => {
  const active = { ...turn("turn-1", 1, "user-1"), status: "running" as const };
  const presentation = resolveConversationComposerPresentation({
    turns: [active],
    interactions: [],
    queue: { state: "running", pauseReason: null, activeTurnId: active.id, version: 1 },
    transportStatus: "ready",
    hasText: true,
    attachmentCount: 0,
    uploadCount: 0,
    canQueue: true,
    canInterrupt: true,
  });
  assert.equal(presentation.action.kind, "queue");
});

test("composer submits on one Enter while preserving newline, IME, and modifier behavior", () => {
  const base = { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false };
  assert.equal(resolveConversationComposerKeyboardAction(base), "submit");
  assert.equal(resolveConversationComposerKeyboardAction({ ...base, shiftKey: true }), "newline");
  assert.equal(resolveConversationComposerKeyboardAction({ ...base, isComposing: true }), "none");
  assert.equal(resolveConversationComposerKeyboardAction({ ...base, metaKey: true }), "none");
});

test("mode switch confirmation retries exactly once", async () => {
  const guard = createModeSwitchRetryGuard();
  let retries = 0;
  const input = {
    recommendationId: "recommendation-1",
    mode: "build" as const,
    switchMode: () => undefined,
    retry: async () => ++retries,
  };
  assert.equal(await guard.run(input), 1);
  assert.equal(await guard.run(input), undefined);
  assert.equal(retries, 1);
});

test("mode switch presentation only accepts the explicit runtime wait contract", () => {
  assert.deepEqual(resolveConversationModeSwitch({
    recommendationId: "request-1",
    originatingMessageId: "message-1",
    fromMode: "chat",
    reason: "This action needs Build mode.",
    metadata: { reason: "acter_mode_blocked", requiredToolClass: "sandboxed_only" },
  }), {
    version: "v1",
    recommendationId: "request-1",
    originatingMessageId: "message-1",
    fromMode: "chat",
    toMode: "build",
    reason: "This action needs Build mode.",
    status: "pending",
  });
  assert.equal(resolveConversationModeSwitch({
    recommendationId: "request-plan",
    originatingMessageId: "message-plan",
    fromMode: "chat",
    reason: "This action belongs in Plan mode.",
    metadata: { reason: "planner_mode_blocked", requiredToolClass: "planning_write" },
  })?.toMode, "plan");
  assert.equal(resolveConversationModeSwitch({
    recommendationId: "request-unknown",
    originatingMessageId: "message-unknown",
    fromMode: "chat",
    reason: "Unknown contract.",
    metadata: { reason: "acter_mode_blocked", requiredToolClass: "write" },
  }), undefined);
  assert.equal(resolveConversationModeSwitch({
    recommendationId: "request-2",
    originatingMessageId: "message-2",
    fromMode: "chat",
    reason: "Continue?",
    metadata: { reason: "ordinary_question", requiredToolClass: "write" },
  }), undefined);
});

test("link presentation accepts only native-openable web destinations", () => {
  assert.deepEqual(describeConversationLink("https://example.com/path?q=1"), {
    url: "https://example.com/path?q=1",
    hostname: "example.com",
    destination: "/path?q=1",
  });
  assert.equal(describeConversationLink("file:///tmp/private"), undefined);
});

function turn(id: string, sequence: number, inputMessageId: string): ConversationTurn {
  return { id, sequence, inputMessageId, status: "running", createdAt, updatedAt: createdAt };
}

function message(id: string, role: ConversationMessageLike["role"], kestrelTurnId?: string): ConversationMessageLike {
  return { id, role, ...(kestrelTurnId ? { metadata: { kestrelTurnId } } : {}) };
}

function runtimeEvent(type: string, extra: Record<string, unknown>) {
  return {
    id: `${type}:${Math.random()}`,
    type,
    ts: createdAt,
    runId: "run-1",
    payload: { update: { runId: "run-1", ts: createdAt, seq: 1, ...extra } },
  };
}
