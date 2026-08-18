import test from "node:test";
import assert from "node:assert/strict";

import {
  conversationConformanceFixture,
  conversationProjectionConformanceScenarios,
  normalizeConversationConformanceProjection,
  normalizeConversationProjectionConformance,
} from "@kestrel-agents/conversation";

import { adaptDesktopConversation } from "../renderer/src/conversationAdapter.js";
import type { DesktopConversationTurn, DesktopOperatorInboxItem } from "../src/contracts.js";

const now = "2026-08-13T12:00:00.000Z";

test("Desktop adapter projects the shared conformance fixture by durable identity", () => {
  const fixture = conversationConformanceFixture;
  const result = adaptDesktopConversation({
    threadId: fixture.threadId,
    transcript: fixture.messages.map((message) => ({
      role: message.role,
      text: message.text,
      timestamp: now,
      ...(message.role === "user"
        ? { data: { kind: "desktop.user-message.v1", messageId: message.id } }
        : { terminal: { runId: message.turnId === "turn-1" ? "run-1" : "run-2" } }),
    })),
    turns: fixture.turns.map((turn) => ({
      turnId: turn.id,
      threadId: fixture.threadId,
      sessionId: "session-1",
      sequence: turn.sequence,
      status: turn.status === "running" ? "RUNNING" : "COMPLETED",
      sourceMessageId: turn.inputMessageId,
      rootRunId: turn.rootRunId,
      terminalRunId: turn.status === "completed" ? turn.rootRunId : undefined,
      terminalStatus: turn.status === "completed" ? "COMPLETED" : undefined,
      startedAt: now,
      updatedAt: now,
      completedAt: turn.status === "completed" ? now : undefined,
    } satisfies DesktopConversationTurn)),
    activeRunId: "run-2",
  });

  assert.deepEqual(
    normalizeConversationConformanceProjection(result.projection),
    fixture.expected,
  );
  assert.equal(result.snapshot.queue.activeTurnId, "turn-2");
  assert.deepEqual(result.issues, []);
});

test("Desktop adapter binds runtime interactions through explicit request and turn identities", () => {
  const inboxItem = {
    itemId: "request:request-1",
    kind: "user_input_request",
    threadId: "thread-1",
    sessionId: "session-1",
    title: "Switch modes",
    actionable: true,
    createdAt: now,
    runId: "run-1",
    turnId: "turn-1",
    requestId: "request-1",
    detail: "user.input",
  } satisfies DesktopOperatorInboxItem;
  const result = adaptDesktopConversation({
    threadId: "thread-1",
    transcript: [],
    turns: [{
      turnId: "turn-1",
      threadId: "thread-1",
      sessionId: "session-1",
      sequence: 1,
      status: "WAITING",
      rootRunId: "run-1",
      startedAt: now,
      updatedAt: now,
    }],
    inboxItems: [inboxItem],
    followUpQueue: { state: "paused", pauseReason: "waiting", items: [] },
    activeRunId: "run-1",
  });

  assert.equal(result.snapshot.interactions[0]?.turnId, "turn-1");
  assert.equal(result.snapshot.queue.pauseReason, "interaction_required");
  assert.deepEqual(result.issues, []);
});

test("Desktop adapter reports legacy lines instead of assigning positional ownership", () => {
  const result = adaptDesktopConversation({
    threadId: "thread-1",
    transcript: [{ role: "system", text: "Legacy notice", timestamp: now }],
    turns: [],
  });
  assert.equal(result.projection.items[0]?.kind, "standalone_message");
  assert.equal(result.issues[0]?.code, "MISSING_MESSAGE_ID");
});

test("Desktop normalizes every shared projection conformance scenario", () => {
  for (const fixture of conversationProjectionConformanceScenarios) {
    const runIdByTurnId = new Map(fixture.turns.map((turn) => {
      const terminal = fixture.messages.find((message) =>
        message.metadata?.kestrelTurnId === turn.id && message.id.startsWith("terminal:"));
      return [turn.id, terminal?.id.slice("terminal:".length) ?? `run:${turn.id}`];
    }));
    const result = adaptDesktopConversation({
      threadId: "thread-conformance",
      transcript: fixture.messages.map((entry) => ({
        role: entry.role,
        text: entry.id,
        timestamp: now,
        ...(entry.role === "user"
          ? {
              data: {
                kind: "desktop.user-message.v1",
                messageId: entry.id,
                ...(entry.metadata?.deliveryState !== undefined
                  ? { deliveryState: entry.metadata.deliveryState }
                  : {}),
              },
            }
          : entry.id.startsWith("terminal:")
            ? {
              terminal: {
                runId: entry.id.startsWith("terminal:")
                  ? entry.id.slice("terminal:".length)
                  : `run:${entry.id}`,
                ...(entry.metadata?.kestrelTurnId !== undefined
                  ? { turnId: entry.metadata.kestrelTurnId }
                  : {}),
              },
            }
            : { data: { kestrelMessageId: entry.id } }),
      })),
      turns: fixture.turns.map((turn) => ({
        turnId: turn.id,
        threadId: "thread-conformance",
        sessionId: "session-1",
        sequence: turn.sequence,
        status: turn.status === "waiting_for_input"
          ? "WAITING"
          : turn.status === "failed" || turn.status === "cancelled"
            ? "FAILED"
            : turn.status === "completed"
              ? "COMPLETED"
              : "RUNNING",
        sourceMessageId: turn.inputMessageId ?? undefined,
        rootRunId: runIdByTurnId.get(turn.id),
        terminalRunId: turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled"
          ? runIdByTurnId.get(turn.id)
          : undefined,
        terminalStatus: turn.status === "cancelled" ? "CANCELLED" : undefined,
        startedAt: now,
        updatedAt: now,
        completedAt: turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled" ? now : undefined,
      } satisfies DesktopConversationTurn)),
      inboxItems: fixture.interactions.map((interaction) => ({
        itemId: interaction.id,
        kind: interaction.kind === "approval" ? "approval_request" : "user_input_request",
        threadId: "thread-conformance",
        sessionId: "session-1",
        title: interaction.prompt,
        actionable: true,
        createdAt: interaction.createdAt,
        turnId: interaction.turnId ?? undefined,
        requestId: interaction.requestId,
      } satisfies DesktopOperatorInboxItem)),
      messageRoutes: fixture.messages.flatMap((message) =>
        message.metadata?.kestrelTurnId === undefined
          ? []
          : [{
              messageId: message.id,
              disposition: "started" as const,
              createdAt: now,
              turnId: message.metadata.kestrelTurnId,
              runId: runIdByTurnId.get(message.metadata.kestrelTurnId),
            }]),
      followUpQueue: {
        state: fixture.queue.state === "paused" ? "paused" : "ready",
        pauseReason: fixture.queue.pauseReason === "turn_failed"
          ? "failed"
          : fixture.queue.pauseReason === "turn_cancelled"
            ? "cancelled"
            : fixture.queue.pauseReason === "interaction_required"
              ? "waiting"
              : undefined,
        items: [],
      },
      activeRunId: fixture.queue.activeTurnId === null
        ? undefined
        : runIdByTurnId.get(fixture.queue.activeTurnId),
    });
    assert.deepEqual(
      normalizeConversationProjectionConformance(result.projection),
      fixture.expected,
      fixture.name,
    );
  }
});
