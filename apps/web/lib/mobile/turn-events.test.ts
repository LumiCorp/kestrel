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

test("mobile SSE exposes user-safe progress without inferring a stage from free-form phase", () => {
  assert.deepEqual(
    toMobileTurnEvent({
      turnId: "turn-1",
      type: "ui.message",
      data: {
        type: "data-kestrel-progress",
        data: {
          phase: "context.read",
          text: "Reviewing the available Project context.",
          internalTrace: "must-not-cross-the-mobile-boundary",
        },
      },
    }),
    {
      type: "activity.updated",
      data: {
        turnId: "turn-1",
        stage: "working",
        message: "Reviewing the available Project context.",
      },
    }
  );
});
