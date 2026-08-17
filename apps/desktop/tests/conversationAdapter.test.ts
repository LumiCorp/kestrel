import test from "node:test";
import assert from "node:assert/strict";

import {
  conversationConformanceFixture,
  normalizeConversationConformanceProjection,
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
