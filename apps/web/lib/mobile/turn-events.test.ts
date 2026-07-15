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
