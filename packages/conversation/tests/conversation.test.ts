import test from "node:test";
import assert from "node:assert/strict";

import {
  conversationActivityConformanceScenarios,
  conversationComposerConformanceScenarios,
  conversationProjectionConformanceScenarios,
  createModeSwitchRetryGuard,
  describeConversationLink,
  normalizeConversationProjectionConformance,
  resolveConversationModeSwitch,
  projectConversation,
  reconcileConversationMessages,
  reduceConversationActivity,
  resolveConversationComposerKeyboardAction,
  resolveConversationComposerPolicy,
  resolveConversationComposerPresentation,
  type ConversationInteraction,
  type ConversationMessageLike,
  type ConversationTurn,
  assertConversationFileSelection,
  CONVERSATION_ATTACHMENT_MAX_FILE_BYTES,
  CONVERSATION_ATTACHMENT_MAX_TURN_BYTES,
  toConversationFileReference,
} from "../src/index.js";

const createdAt = "2026-08-13T12:00:00.000Z";

test("universal file selection enforces exact count and byte boundaries", () => {
  const attachment = (fileId: string, sizeBytes: number) => ({ fileId, sizeBytes });
  assert.doesNotThrow(() => assertConversationFileSelection([
    attachment("exact-file-limit", CONVERSATION_ATTACHMENT_MAX_FILE_BYTES),
  ]));
  assert.doesNotThrow(() => assertConversationFileSelection(
    Array.from({ length: 20 }, (_, index) => attachment(`attachment-${index}`, 25 * 1024 * 1024)),
  ));
  assert.throws(() => assertConversationFileSelection([
    attachment("over-file-limit", CONVERSATION_ATTACHMENT_MAX_FILE_BYTES + 1),
  ]), /at most/u);
  assert.throws(() => assertConversationFileSelection(
    Array.from({ length: 21 }, (_, index) => attachment(`attachment-${index}`, 0)),
  ), /at most 20/u);
  assert.throws(() => assertConversationFileSelection([
    ...Array.from({ length: 5 }, (_, index) =>
      attachment(`full-${index}`, CONVERSATION_ATTACHMENT_MAX_FILE_BYTES)),
    attachment("one-byte-over", 1),
  ]), /total/u);
  assert.throws(() => assertConversationFileSelection([
    attachment("duplicate", 0),
    attachment("duplicate", 0),
  ]), /unique/u);
});

test("canonical file references carry stable identity instead of bytes or URLs", () => {
  const reference = toConversationFileReference({
    fileId: "file-1",
    organizationId: "organization-1",
    filename: "archive.zip",
    sizeBytes: 12,
    sha256: "0".repeat(64),
    detectedMediaType: "application/zip",
    lifecycleState: "ready",
    representation: { kind: "metadata_only", reason: "No processor." },
    scopes: [{ kind: "thread", threadId: "thread-1" }],
    createdAt,
  });
  assert.deepEqual(reference, {
    type: "kestrel-file",
    fileId: "file-1",
    filename: "archive.zip",
    sizeBytes: 12,
    mediaType: "application/zip",
    representationKind: "metadata_only",
    status: "ready",
  });
  assert.equal("url" in reference, false);
  assert.equal("data" in reference, false);
});

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

test("reports duplicate authoritative turn sequences without timestamp ordering", () => {
  const projected = projectConversation({
    messages: [],
    turns: [
      { ...turn("turn-z", 1, "user-z"), createdAt: "2026-01-01T00:00:00.000Z" },
      { ...turn("turn-a", 1, "user-a"), createdAt: "2027-01-01T00:00:00.000Z" },
    ],
    interactions: [],
  });
  assert.deepEqual(projected.items.map((item) => item.kind === "durable_turn" ? item.turnId : ""), ["turn-a", "turn-z"]);
  assert.equal(projected.issues[0]?.code, "TURN_SEQUENCE_CONFLICT");
});

test("reports and deterministically orders turns without authoritative sequence", () => {
  const projected = projectConversation({
    messages: [],
    turns: [
      { ...turn("turn-z", 2, "user-z"), createdAt: "2025-01-01T00:00:00.000Z" },
      { ...turn("turn-b", 3, "user-b"), sequence: null, createdAt: "2024-01-01T00:00:00.000Z" },
      { ...turn("turn-a", 1, "user-a"), sequence: null, createdAt: "2027-01-01T00:00:00.000Z" },
      { ...turn("turn-c", 1, "user-c"), createdAt: "2028-01-01T00:00:00.000Z" },
    ],
    interactions: [],
  });
  assert.deepEqual(
    projected.items.map((item) => item.kind === "durable_turn" ? item.turnId : ""),
    ["turn-c", "turn-z", "turn-a", "turn-b"],
  );
  assert.deepEqual(
    projected.issues.filter((issue) => issue.code === "TURN_SEQUENCE_MISSING").map((issue) => issue.turnId),
    ["turn-a", "turn-b"],
  );
});

test("runs every shared projection conformance scenario", () => {
  for (const fixture of conversationProjectionConformanceScenarios) {
    const projected = projectConversation(fixture);
    assert.deepEqual(normalizeConversationProjectionConformance(projected), fixture.expected, fixture.name);
  }
});

test("orders an explicit historical interaction request before its response", () => {
  const interaction: ConversationInteraction = {
    id: "interaction-1",
    requestId: "request-1",
    source: "runtime",
    kind: "user_input",
    eventType: "user.reply",
    prompt: "Continue?",
    status: "resolved",
    turnId: "turn-1",
    assistantMessageId: "assistant-request",
    responseMessageId: "user-response",
    createdAt,
    resolvedAt: createdAt,
  };
  const projected = projectConversation({
    turns: [turn("turn-1", 1, "user-input")],
    interactions: [interaction],
    messages: [
      message("user-response", "user", "turn-1"),
      message("assistant-request", "assistant", "turn-1"),
      message("user-input", "user", "turn-1"),
    ],
  });
  const item = projected.items[0];
  assert.equal(item?.kind, "durable_turn");
  if (item?.kind !== "durable_turn") assert.fail("expected durable turn");
  assert.deepEqual(item.messages.map((entry) => entry.id), ["user-input", "assistant-request", "user-response"]);
});

test("preserves source order when an interaction link is incomplete or crosses turns", () => {
  const projected = projectConversation({
    turns: [
      turn("turn-1", 1, "input-1"),
      turn("turn-2", 2, "input-2"),
    ],
    interactions: [
      {
        id: "interaction-incomplete",
        requestId: "request-incomplete",
        source: "runtime",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
        status: "resolved",
        turnId: "turn-1",
        assistantMessageId: null,
        responseMessageId: "response-1",
        createdAt,
      },
      {
        id: "interaction-cross-turn",
        requestId: "request-cross-turn",
        source: "runtime",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
        status: "resolved",
        turnId: "turn-1",
        assistantMessageId: "assistant-1",
        responseMessageId: "input-2",
        createdAt,
      },
    ],
    messages: [
      message("input-1", "user", "turn-1"),
      message("response-1", "user", "turn-1"),
      message("assistant-1", "assistant", "turn-1"),
      message("input-2", "user", "turn-2"),
    ],
  });
  const first = projected.items[0];
  assert.equal(first?.kind, "durable_turn");
  if (first?.kind !== "durable_turn") assert.fail("expected first durable turn");
  assert.deepEqual(first.messages.map((entry) => entry.id), ["input-1", "response-1", "assistant-1"]);
  assert.equal(
    projected.issues.some((issue) => issue.code === "MESSAGE_ORDER_CONFLICT"),
    false,
  );
});

test("reports causal cycles while retaining every message in source order", () => {
  const projected = projectConversation({
    turns: [turn("turn-1", 1, "input-1")],
    interactions: [
      {
        id: "interaction-a",
        requestId: "request-a",
        source: "runtime",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
        status: "resolved",
        turnId: "turn-1",
        assistantMessageId: "message-a",
        responseMessageId: "message-b",
        createdAt,
      },
      {
        id: "interaction-b",
        requestId: "request-b",
        source: "runtime",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
        status: "resolved",
        turnId: "turn-1",
        assistantMessageId: "message-b",
        responseMessageId: "message-a",
        createdAt,
      },
    ],
    messages: [
      message("input-1", "user", "turn-1"),
      message("message-b", "user", "turn-1"),
      message("message-a", "assistant", "turn-1"),
    ],
  });
  const item = projected.items[0];
  assert.equal(item?.kind, "durable_turn");
  if (item?.kind !== "durable_turn") assert.fail("expected durable turn");
  assert.deepEqual(item.messages.map((entry) => entry.id), ["input-1", "message-b", "message-a"]);
  assert.deepEqual(projected.issues.find((issue) => issue.code === "MESSAGE_ORDER_CONFLICT"), {
    code: "MESSAGE_ORDER_CONFLICT",
    message: "Durable turn 'turn-1' has contradictory causal message ordering.",
    turnId: "turn-1",
    messageIds: ["message-b", "message-a"],
  });
});

test("runs every shared activity conformance scenario", () => {
  for (const fixture of conversationActivityConformanceScenarios) {
    const result = fixture.events.reduce(reduceConversationActivity, []);
    assert.deepEqual(result.map((item) => ({
      kind: item.kind,
      runId: item.runId,
      status: item.status,
      text: item.text,
    })), fixture.expected, fixture.name);
  }
});

test("runs every shared composer conformance scenario", () => {
  for (const fixture of conversationComposerConformanceScenarios) {
    assert.equal(resolveConversationComposerPolicy(fixture).mode, fixture.expectedMode, fixture.name);
  }
});

test("terminal persisted messages replace stale live messages", () => {
  const turns = [{ ...turn("turn-1", 1, "user-1"), status: "completed" as const }];
  const persisted = [{ ...message("assistant-1", "assistant", "turn-1"), value: "final" }];
  const live = [{ ...message("assistant-1", "assistant", "turn-1"), value: "partial" }];
  assert.equal(reconcileConversationMessages({ persistedMessages: persisted, liveMessages: live, turns })[0]?.value, "final");
});

test("interleaved reasoning formats update one reasoning stream", () => {
  const events = [
    runtimeEvent("run.model.reasoning.started", { attempt: 1, format: "summary", contentState: "live" }, { sequence: 1 }),
    runtimeEvent("run.model.reasoning.delta", { attempt: 1, format: "summary", contentState: "live", delta: "Inspecting " }, { sequence: 2 }),
    runtimeEvent("run.agent_progress", { message: "Still working.", stepAgent: "agent.loop" }, { sequence: 3 }),
    runtimeEvent("run.model.reasoning.delta", { attempt: 1, format: "provider_reasoning_text", contentState: "live", delta: "the workspace." }, { sequence: 4 }),
  ];
  const result = events.reduce(reduceConversationActivity, []);
  assert.equal(result.filter((item) => item.kind === "reasoning").length, 1);
  assert.equal(result.find((item) => item.kind === "reasoning")?.text, "Inspecting the workspace.");
});

test("activity replay is idempotent and run starts are isolated", () => {
  const first = runtimeEvent("run.model.reasoning.delta", {
    attempt: 1,
    format: "summary",
    contentState: "live",
    delta: "Inspecting.",
  }, { id: "reasoning-1", runId: "run-1", sequence: 1 });
  const other = runtimeEvent("run.agent_progress", { message: "Other run." }, {
    id: "progress-2",
    runId: "run-2",
    sequence: 1,
  });
  const replayed = [first, other, first].reduce(reduceConversationActivity, []);
  assert.equal(replayed.find((item) => item.kind === "reasoning")?.text, "Inspecting.");
  const restarted = reduceConversationActivity(replayed, {
    id: "started-1",
    type: "run.started",
    ts: createdAt,
    runId: "run-1",
    payload: {},
  });
  const replayedStart = reduceConversationActivity([
    ...restarted,
    {
      id: "progress-after-start",
      kind: "agent_progress",
      label: "Agent progress",
      text: "Still working.",
      timestamp: createdAt,
      status: "active",
      runId: "run-1",
      sourceEventId: "progress-after-start",
    } as const,
  ], {
    id: "started-1",
    type: "run.started",
    ts: createdAt,
    runId: "run-1",
    payload: {},
  });
  assert.deepEqual(
    replayedStart.filter((item) => item.visible !== false).map((item) => [item.runId, item.text]),
    [["run-2", "Other run."], ["run-1", "Still working."]],
  );
});

test("terminal events retire only the activity owned by their run", () => {
  const active = [
    runtimeEvent("run.agent_progress", { message: "First run." }, { id: "progress-1", runId: "run-1", sequence: 1 }),
    runtimeEvent("run.agent_progress", { message: "Second run." }, { id: "progress-2", runId: "run-2", sequence: 1 }),
  ].reduce(reduceConversationActivity, []);
  const completed = reduceConversationActivity(active, {
    id: "completed-1",
    type: "run.completed",
    ts: createdAt,
    runId: "run-1",
    payload: { result: { output: { runId: "run-1" } } },
  });
  assert.deepEqual(completed.filter((item) => item.visible !== false).map((item) => [item.runId, item.text]), [
    ["run-2", "Second run."],
  ]);
});

test("run-start replay identity survives visible activity compaction", () => {
  const started = reduceConversationActivity([], {
    id: "started-long-run",
    type: "run.started",
    ts: createdAt,
    runId: "run-long",
    payload: {},
  });
  const crowded = Array.from({ length: 81 }, (_, index) => runtimeEvent(
    "run.agent_progress",
    { message: `Other ${index}` },
    { runId: "run-other", sequence: index + 1 },
  )).reduce(reduceConversationActivity, started);
  const withOwnProgress = reduceConversationActivity(crowded, runtimeEvent(
    "run.agent_progress",
    { message: "Long run progress" },
    { id: "long-progress", runId: "run-long", sequence: 1 },
  ));
  const replayed = reduceConversationActivity(withOwnProgress, {
    id: "started-long-run",
    type: "run.started",
    ts: createdAt,
    runId: "run-long",
    payload: {},
  });
  assert.equal(replayed.some((item) => item.sourceEventId === "long-progress"), true);
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

function runtimeEvent(
  type: string,
  extra: Record<string, unknown>,
  identity: { id?: string; runId?: string; sequence?: number } = {},
) {
  runtimeEventId += 1;
  const runId = identity.runId ?? "run-1";
  return {
    id: identity.id ?? `${type}:${runtimeEventId}`,
    type,
    ts: createdAt,
    runId,
    payload: { update: { runId, ts: createdAt, seq: identity.sequence ?? 1, ...extra } },
  };
}

let runtimeEventId = 0;
