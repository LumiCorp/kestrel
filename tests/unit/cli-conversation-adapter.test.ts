import test from "node:test";
import assert from "node:assert/strict";

import {
  conversationProjectionConformanceScenarios,
  normalizeConversationProjectionConformance,
  type ConversationActivityItem,
  type ConversationProjectionConformanceScenario,
} from "@kestrel-agents/conversation";
import type { OperatorThreadView } from "../../src/orchestration/contracts.js";
import type { ProtocolClient } from "../../cli/client/ProtocolClient.js";
import type { RunnerEvent } from "../../cli/protocol/contracts.js";
import {
  adaptTuiConversation,
  createTuiConversationCommandAdapter,
  projectTuiTerminalOutcome,
  projectTuiTranscript,
  reduceTuiConversationActivity,
  resolveTuiComposerPolicy,
} from "../../cli/app/TuiConversationAdapter.js";

for (const scenario of conversationProjectionConformanceScenarios) {
  test(`TUI shared projection conformance: ${scenario.name}`, () => {
    const adapted = adaptTuiConversation(toTuiConformanceInput(scenario));
    assert.deepEqual(
      normalizeConversationProjectionConformance(adapted.projection),
      scenario.expected,
    );
  });
}

test("TUI snapshot binds the optimistic history event to the promoted durable turn", () => {
  const transcript = [{
    eventId: "message-1",
    role: "user" as const,
    text: "same text",
    data: {
      kind: "tui.user-message.v1",
      messageId: "message-1",
      deliveryState: "submitting",
    },
    timestamp: "2026-08-17T10:00:00.000Z",
  }];
  const queued = adaptTuiConversation({
    threadId: "thread-1",
    transcript,
    view: threadView({ status: "RUNNING", routeDisposition: "queued" }),
  });
  assert.equal(queued.snapshot.messages[0]?.id, "message-1");
  assert.equal(queued.snapshot.messages[0]?.metadata?.kestrelTurnId, "turn-1");
  assert.equal(queued.snapshot.messages[0]?.metadata?.deliveryState, "queued");

  const promoted = adaptTuiConversation({
    threadId: "thread-1",
    transcript,
    view: threadView({ status: "RUNNING", routeDisposition: "started" }),
  });
  const projected = promoted.projection.items[0];
  assert.equal(projected?.kind, "durable_turn");
  if (projected?.kind === "durable_turn") {
    assert.equal(projected.messages[0]?.id, "message-1");
    assert.equal(projected.messages[0]?.metadata?.deliveryState, undefined);
  }
});

test("TUI snapshot derives queued delivery from the authoritative route before a turn exists", () => {
  const transcript = [{
    eventId: "message-queued",
    role: "user" as const,
    text: "next task",
    data: { kind: "tui.user-message.v1", messageId: "message-queued", deliveryState: "submitting" },
    timestamp: "2026-08-17T10:00:00.000Z",
  }];
  const view = threadView({ status: "RUNNING", routeDisposition: "started" });
  view.conversationMessageRoutes!.push({
    messageId: "message-queued",
    disposition: "queued",
    followUpId: "follow-up:message-queued",
    createdAt: "2026-08-17T10:00:01.000Z",
  });
  view.followUpQueue!.items.push({
    followUpId: "follow-up:message-queued",
    message: "next task",
    attachmentIds: [],
    createdAt: "2026-08-17T10:00:01.000Z",
    state: "queued",
    source: "human",
    sourceMessageId: "message-queued",
  });

  const adapted = adaptTuiConversation({ threadId: "thread-1", transcript, view });
  assert.equal(adapted.snapshot.messages[0]?.metadata?.deliveryState, "queued");
  assert.equal(adapted.snapshot.messages[0]?.metadata?.kestrelTurnId, undefined);
  assert.equal(projectTuiTranscript(transcript, adapted)[0]?.eventId, "message-queued");
});

test("TUI interaction replies retain explicit turn ownership and clear optimistic delivery", () => {
  const view = threadView({ status: "WAITING", routeDisposition: "replied" });
  const adapted = adaptTuiConversation({
    threadId: "thread-1",
    transcript: [{
      eventId: "reply-1",
      role: "user",
      text: "continue",
      data: {
        kind: "tui.user-message.v1",
        messageId: "reply-1",
        turnId: "turn-1",
        deliveryState: "submitting",
      },
      timestamp: "2026-08-17T10:00:01.000Z",
    }],
    view,
  });
  assert.equal(adapted.snapshot.messages[0]?.metadata?.kestrelTurnId, "turn-1");
  const item = adapted.projection.items[0];
  assert.equal(item?.kind, "durable_turn");
  if (item?.kind !== "durable_turn") assert.fail("expected durable turn");
  assert.equal(item.messages[0]?.metadata?.deliveryState, undefined);
});

test("TUI projection orders durable turns without moving host-owned system slots", () => {
  const transcript = [{
    eventId: "system-1",
    role: "system" as const,
    text: "workspace selected",
    timestamp: "2026-08-17T10:00:00.000Z",
  }, {
    eventId: "message-2",
    role: "user" as const,
    text: "second",
    data: { messageId: "message-2" },
    timestamp: "2026-08-17T10:00:02.000Z",
  }, {
    eventId: "message-1",
    role: "user" as const,
    text: "first",
    data: { messageId: "message-1" },
    timestamp: "2026-08-17T10:00:01.000Z",
  }];
  const view = threadView({ status: "RUNNING", routeDisposition: "started" });
  view.conversationTurns = [
    view.conversationTurns![0]!,
    { ...view.conversationTurns![0]!, turnId: "turn-2", sequence: 2, sourceMessageId: "message-2" },
  ];
  view.conversationMessageRoutes = [
    view.conversationMessageRoutes![0]!,
    { ...view.conversationMessageRoutes![0]!, messageId: "message-2", turnId: "turn-2" },
  ];
  const adapted = adaptTuiConversation({ threadId: "thread-1", transcript, view });
  const projected = projectTuiTranscript(transcript, adapted);
  assert.deepEqual(projected.map((line) => line.eventId), ["system-1", "message-1", "message-2"]);
});

test("TUI preserves an explicitly owned message when its turn record is absent", () => {
  const transcript = [{
    eventId: "terminal:run-missing",
    role: "system" as const,
    text: "Run failed: provider unavailable",
    data: {
      kind: "runtime.terminal.v1",
      turnId: "turn-missing",
      runId: "run-missing",
      terminalStatus: "failed",
    },
    timestamp: "2026-08-17T10:00:00.000Z",
  }];
  const adapted = adaptTuiConversation({
    threadId: "thread-1",
    transcript,
    view: { ...threadView({ status: "RUNNING", routeDisposition: "started" }), conversationTurns: [] },
  });

  assert.equal(adapted.projection.items[0]?.kind, "standalone_message");
  assert.equal(adapted.projection.issues[0]?.code, "MISSING_TURN_RECORD");
  assert.deepEqual(projectTuiTranscript(transcript, adapted), transcript);
});

test("TUI keeps terminal content and host grounding notices as distinct messages", () => {
  const transcript = [{
    eventId: "terminal:run-1",
    role: "assistant" as const,
    text: "Completed answer.",
    timestamp: "2026-08-17T10:00:00.000Z",
    run: {
      runId: "run-1",
      status: "COMPLETED" as const,
      telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 1, durationMs: 10 },
      errors: [],
    },
  }, {
    eventId: "terminal:run-1:grounding",
    role: "system" as const,
    text: "Grounding notice.",
    timestamp: "2026-08-17T10:00:00.000Z",
    run: {
      runId: "run-1",
      status: "COMPLETED" as const,
      telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 1, durationMs: 10 },
      errors: [],
    },
  }];
  const adapted = adaptTuiConversation({ threadId: "thread-1", transcript });
  assert.deepEqual(
    adapted.snapshot.messages.map((message) => message.id),
    ["terminal:run-1", "terminal:run-1:grounding"],
  );
});

test("TUI terminal recovery preserves cancelled and contract-failure outcomes", () => {
  const cancelled = projectTuiTerminalOutcome({
    messageId: "terminal:run-1",
    turnId: "turn-1",
    threadId: "thread-1",
    sessionId: "session-1",
    runId: "run-1",
    completedAt: "2026-08-17T10:01:00.000Z",
    terminalStatus: "FAILED",
    outcomeStatus: "cancelled",
    handoffState: "delivered",
    result: {
      assistantText: null,
      output: output({ code: "RUN_CANCELLED", message: "Run cancelled." }),
    },
  });
  assert.equal(cancelled.eventId, "terminal:run-1");
  assert.equal(cancelled.data?.terminalStatus, "cancelled");

  const cancelledView = threadView({ status: "FAILED", routeDisposition: "started" });
  cancelledView.conversationTurns![0] = {
    ...cancelledView.conversationTurns![0]!,
    terminalRunId: "run-1",
  };
  const cancelledSnapshot = adaptTuiConversation({
    threadId: "thread-1",
    transcript: [cancelled],
    view: cancelledView,
  });
  assert.equal(cancelledSnapshot.snapshot.turns[0]?.status, "cancelled");

  const contractFailure = projectTuiTerminalOutcome({
    messageId: "terminal:run-2",
    turnId: "turn-2",
    threadId: "thread-1",
    sessionId: "session-1",
    runId: "run-2",
    completedAt: "2026-08-17T10:02:00.000Z",
    terminalStatus: "FAILED",
    outcomeStatus: "contract_failure",
    handoffState: "failed",
    finalizationError: { code: "FINAL_RESPONSE_INVALID", message: "Missing response text." },
  });
  assert.equal(contractFailure.data?.terminalStatus, "contract_failure");
  assert.match(contractFailure.text, /Missing response text/u);
});

test("TUI composer answers only explicit runtime user input and blocks approval", () => {
  const view = threadView({ status: "WAITING", routeDisposition: "replied" });
  view.inboxItems = [{
    itemId: "inbox-1",
    kind: "user_input_request",
    threadId: "thread-1",
    sessionId: "session-1",
    title: "Need input",
    actionable: true,
    createdAt: "2026-08-17T10:00:00.000Z",
    turnId: "turn-1",
    requestId: "request-1",
  }];
  const input = adaptTuiConversation({ threadId: "thread-1", transcript: [], view });
  assert.equal(resolveTuiComposerPolicy(input.snapshot, "ready").mode, "answer_interaction");

  view.inboxItems[0] = { ...view.inboxItems[0]!, kind: "approval_request" };
  const approval = adaptTuiConversation({ threadId: "thread-1", transcript: [], view });
  assert.equal(resolveTuiComposerPolicy(approval.snapshot, "ready").mode, "blocked_interaction");
});

test("TUI activity replay is run-scoped, attempt-scoped, and event-idempotent", () => {
  let activity: ConversationActivityItem[] = [];
  const event = reasoningEvent("event-1", "run-1", 1, 1, "one");
  activity = reduceTuiConversationActivity(activity, event);
  activity = reduceTuiConversationActivity(activity, event);
  activity = reduceTuiConversationActivity(activity, reasoningEvent("event-2", "run-1", 2, 2, "two"));
  activity = reduceTuiConversationActivity(activity, reasoningEvent("event-3", "run-2", 1, 1, "other"));
  assert.deepEqual(activity.filter((item) => item.kind === "reasoning").map((item) => item.text), ["one", "two", "other"]);

  activity = reduceTuiConversationActivity(activity, {
    id: "start-2",
    type: "run.started",
    ts: "2026-08-17T10:00:03.000Z",
    runId: "run-2",
    payload: { sessionId: "session-1", eventType: "user.message" },
  } as RunnerEvent);
  assert.equal(activity.some((item) => item.runId === "run-1"), true);
  assert.equal(activity.some((item) => item.runId === "run-2" && item.visible !== false), false);

  activity = reduceTuiConversationActivity(activity, {
    id: "progress-after-start-2",
    type: "run.agent_progress",
    ts: "2026-08-17T10:00:04.000Z",
    runId: "run-2",
    payload: {
      update: {
        sessionId: "session-1",
        runId: "run-2",
        message: "Still working.",
        ts: "2026-08-17T10:00:04.000Z",
        seq: 2,
      },
    },
  } as RunnerEvent);
  activity = reduceTuiConversationActivity(activity, {
    id: "start-2",
    type: "run.started",
    ts: "2026-08-17T10:00:03.000Z",
    runId: "run-2",
    payload: { sessionId: "session-1", eventType: "user.message" },
  } as RunnerEvent);
  assert.equal(activity.some((item) => item.text === "Still working."), true);
});

test("TUI command adapter delegates native commands and mode retry idempotently", async () => {
  const calls: Array<{ type: string; payload: unknown }> = [];
  const response = {
    id: "event-1",
    type: "operator.controlled",
    ts: "2026-08-17T10:00:00.000Z",
    payload: { threadId: "thread-1" },
  } as RunnerEvent;
  const client = {
    async sendCommand(type: string, payload: unknown) {
      calls.push({ type, payload });
      return response;
    },
  } as unknown as ProtocolClient;
  const switched: string[] = [];
  const adapter = createTuiConversationCommandAdapter({
    client,
    resolveInterrupt: () => ({ sessionId: "session-1", runId: "run-1" }),
    installInterrupt: () => undefined,
    switchMode: (mode) => { switched.push(mode); },
  });
  const answer = {
    requestId: "request-1",
    payload: { action: "reply" as const, threadId: "thread-1", requestId: "request-1", message: "ok" },
    install: () => undefined,
  };
  await adapter.switchModeAndRetry({ recommendationId: "recommendation-1", mode: "build", answer });
  await adapter.switchModeAndRetry({ recommendationId: "recommendation-1", mode: "build", answer });
  await adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-1" });
  assert.deepEqual(switched, ["build"]);
  assert.deepEqual(calls.map((call) => call.type), ["operator.control", "run.cancel"]);
});

function threadView(input: {
  status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  routeDisposition: "started" | "replied" | "queued";
}): OperatorThreadView {
  return {
    thread: {
      threadId: "thread-1",
      sessionId: "session-1",
      title: "Thread",
      status: input.status,
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
    },
    childThreads: [],
    childBlockerChain: [],
    conversationTurns: [{
      turnId: "turn-1",
      threadId: "thread-1",
      sessionId: "session-1",
      sequence: 1,
      status: input.status,
      sourceMessageId: "message-1",
      rootRunId: "run-1",
      activeRunId: input.status === "RUNNING" || input.status === "WAITING" ? "run-1" : undefined,
      startedAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
    }],
    conversationMessageRoutes: [{
      messageId: "message-1",
      disposition: input.routeDisposition,
      createdAt: "2026-08-17T10:00:00.000Z",
      turnId: "turn-1",
      runId: "run-1",
    }],
    activeRun: input.status === "RUNNING" || input.status === "WAITING"
      ? { runId: "run-1", status: input.status }
      : undefined,
    followUpQueue: { state: "ready", items: [] },
  };
}

function toTuiConformanceInput(scenario: ConversationProjectionConformanceScenario): {
  threadId: string;
  transcript: Array<{
    eventId: string;
    role: "user" | "assistant" | "system";
    text: string;
    data: { messageId: string; deliveryState?: "submitting" | "queued" };
    timestamp: string;
  }>;
  view: OperatorThreadView;
} {
  const timestamp = "2026-08-17T10:00:00.000Z";
  const statusByTurn = new Map(scenario.turns.map((turn) => [turn.id, turn.status]));
  return {
    threadId: "thread-conformance",
    transcript: scenario.messages.map((message) => ({
      eventId: message.id,
      role: message.role,
      text: message.id,
      data: {
        messageId: message.id,
        ...(message.metadata?.deliveryState === "submitting" || message.metadata?.deliveryState === "queued"
          ? { deliveryState: message.metadata.deliveryState }
          : {}),
      },
      timestamp,
    })),
    view: {
      thread: {
        threadId: "thread-conformance",
        sessionId: "session-conformance",
        title: scenario.name,
        status: "RUNNING",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      childThreads: [],
      childBlockerChain: [],
      conversationTurns: scenario.turns.map((turn) => ({
        turnId: turn.id,
        threadId: "thread-conformance",
        sessionId: "session-conformance",
        sequence: turn.sequence,
        status: turn.status === "running" || turn.status === "queued"
          ? "RUNNING"
          : turn.status === "waiting_for_input"
            ? "WAITING"
            : turn.status === "completed"
              ? "COMPLETED"
              : "FAILED",
        sourceMessageId: turn.inputMessageId ?? undefined,
        ...(turn.status === "cancelled" ? { terminalStatus: "CANCELLED" } : {}),
        startedAt: timestamp,
        updatedAt: timestamp,
      })),
      conversationMessageRoutes: scenario.messages.flatMap((message) => {
        const turnId = message.metadata?.kestrelTurnId;
        if (turnId === undefined) return [];
        return [{
          messageId: message.id,
          disposition: message.metadata?.deliveryState === "queued" ? "queued" as const : "started" as const,
          createdAt: timestamp,
          turnId,
        }];
      }),
      inboxItems: scenario.interactions.map((interaction) => ({
        itemId: interaction.id,
        kind: interaction.kind === "approval" ? "approval_request" as const : "user_input_request" as const,
        threadId: "thread-conformance",
        sessionId: "session-conformance",
        title: interaction.prompt,
        actionable: interaction.status === "pending",
        createdAt: interaction.createdAt,
        turnId: interaction.turnId ?? undefined,
        requestId: interaction.requestId,
      })),
      activeRun: scenario.queue.activeTurnId === null
        ? undefined
        : {
            runId: scenario.queue.activeTurnId,
            status: statusByTurn.get(scenario.queue.activeTurnId) === "waiting_for_input" ? "WAITING" : "RUNNING",
          },
      followUpQueue: {
        state: scenario.queue.state === "paused" ? "paused" : "ready",
        ...(scenario.queue.pauseReason === "turn_failed"
          ? { pauseReason: "failed" as const }
          : scenario.queue.pauseReason === "turn_cancelled"
            ? { pauseReason: "cancelled" as const }
            : scenario.queue.pauseReason === "interaction_required"
              ? { pauseReason: "waiting" as const }
              : {}),
        items: [],
      },
    },
  };
}

function reasoningEvent(id: string, runId: string, attempt: number, seq: number, delta: string): RunnerEvent {
  return {
    id,
    type: "run.model.reasoning.delta",
    ts: "2026-08-17T10:00:00.000Z",
    runId,
    sessionId: "session-1",
    payload: {
      update: {
        version: "v1",
        runId,
        sessionId: "session-1",
        attempt,
        seq,
        ts: "2026-08-17T10:00:00.000Z",
        format: "summary",
        event: "delta",
        contentState: "live",
        delta,
      },
    },
  } as RunnerEvent;
}

function output(error: { code: string; message: string }) {
  return {
    sessionId: "session-1",
    runId: "run-1",
    status: "FAILED" as const,
    finalStep: "finalize" as const,
    stepResults: [],
    telemetry: {
      stepsExecuted: 0,
      toolCalls: 0,
      modelCalls: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    errors: [error],
    quality: {
      status: "not_evaluated" as const,
      evaluationErrors: [],
      citationCoverage: 0,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: 0,
    },
  };
}
