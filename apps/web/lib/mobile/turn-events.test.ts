import assert from "node:assert/strict";
import test from "node:test";
import { toMobileTurnEvent } from "./event-contract";

test("mobile SSE translates text deltas without exposing runner event payloads", () => {
  assert.deepEqual(
    toMobileTurnEvent({
      turnId: "turn-1",
      type: "ui.message",
      data: { type: "text-delta", id: "text-1", delta: "Hello" },
    }),
    {
      type: "message.delta",
      data: { turnId: "turn-1", textDelta: "Hello" },
    }
  );
});

test("mobile SSE collapses internal lifecycle events to a snapshot invalidation", () => {
  assert.deepEqual(
    toMobileTurnEvent({
      turnId: "turn-1",
      type: "turn.failed",
      data: { failureMessage: "internal validator text" },
    }),
    {
      type: "snapshot.changed",
      data: { turnId: "turn-1", reason: "turn_updated" },
    }
  );
});

test("mobile SSE delivers explicitly projected durable activity", () => {
  assert.deepEqual(
    toMobileTurnEvent({
      turnId: "turn-1",
      type: "turn.activity",
      data: { stage: "reading_context", message: "Reading context" },
    }),
    {
      type: "activity.updated",
      data: {
        turnId: "turn-1",
        stage: "reading_context",
        message: "Reading context",
      },
    }
  );
});

test("mobile SSE normalizes progress codes into stable user-safe activity", () => {
  assert.deepEqual(
    toMobileTurnEvent({
      turnId: "turn-1",
      type: "ui.message",
      data: {
        type: "data-kestrel-progress",
        data: {
          phase: "context.read",
          code: "MODEL_CALL_STARTED",
          text: "Calling decision model (Qwen/Qwen3-8B).",
          internalTrace: "must-not-cross-the-mobile-boundary",
        },
      },
    }),
    {
      type: "activity.updated",
      data: {
        turnId: "turn-1",
        stage: "working",
        message: "Working",
      },
    }
  );
});

test("mobile SSE presents tool progress without exposing free-form text", () => {
  assert.deepEqual(
    toMobileTurnEvent({
      turnId: "turn-1",
      type: "ui.message",
      data: {
        type: "data-kestrel-progress",
        data: {
          code: "TOOL_CALL_STARTED",
          text: "Calling private tool with internal arguments.",
        },
      },
    }),
    {
      type: "activity.updated",
      data: {
        turnId: "turn-1",
        stage: "using_capability",
        message: "Using a capability",
      },
    }
  );
});

test("mobile SSE preserves canonical agent-authored progress narration", () => {
  assert.deepEqual(
    toMobileTurnEvent({
      turnId: "turn-1",
      type: "ui.message",
      data: {
        type: "data-kestrel-agent-progress",
        data: {
          text: "I found the relevant sources and am comparing them now.",
        },
      },
    }),
    {
      type: "activity.updated",
      data: {
        turnId: "turn-1",
        stage: "working",
        message: "I found the relevant sources and am comparing them now.",
      },
    }
  );
});

test("mobile SSE projects typed tool parts as capability activity", () => {
  assert.deepEqual(
    toMobileTurnEvent({
      turnId: "turn-1",
      type: "ui.message",
      data: {
        type: "data-kestrel-tool",
        data: { toolName: "private.internal.tool", phase: "started" },
      },
    }),
    {
      type: "activity.updated",
      data: {
        turnId: "turn-1",
        stage: "using_capability",
        message: "Using a capability",
      },
    }
  );
});
