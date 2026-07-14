import assert from "node:assert/strict";
import test from "node:test";
import {
  assertThreadTurnTransition,
  decodeTurnEventCursor,
  encodeTurnEventCursor,
  terminalQueueOutcome,
} from "./contracts";

test("durable turn transitions reject replay-unsafe state changes", () => {
  assert.doesNotThrow(() => assertThreadTurnTransition("queued", "running"));
  assert.doesNotThrow(() =>
    assertThreadTurnTransition("running", "waiting_for_input")
  );
  assert.doesNotThrow(() =>
    assertThreadTurnTransition("waiting_for_input", "running")
  );
  assert.doesNotThrow(() =>
    assertThreadTurnTransition("waiting_for_input", "completed")
  );
  assert.throws(
    () => assertThreadTurnTransition("completed", "running"),
    /Invalid durable turn transition/u
  );
  assert.throws(
    () => assertThreadTurnTransition("queued", "completed"),
    /Invalid durable turn transition/u
  );
});

test("only successful turns automatically release the next queued turn", () => {
  assert.deepEqual(terminalQueueOutcome("completed"), {
    state: "running",
    pauseReason: null,
    dispatchNext: true,
  });
  assert.deepEqual(terminalQueueOutcome("failed"), {
    state: "paused",
    pauseReason: "turn_failed",
    dispatchNext: false,
  });
  assert.deepEqual(terminalQueueOutcome("cancelled"), {
    state: "paused",
    pauseReason: "turn_cancelled",
    dispatchNext: false,
  });
});

test("event cursors round trip without exposing database offsets", () => {
  const cursor = encodeTurnEventCursor("turn:with:colons", 42);
  assert.deepEqual(decodeTurnEventCursor(cursor), {
    turnId: "turn:with:colons",
    sequence: 42,
  });
  assert.equal(decodeTurnEventCursor(null), null);
  assert.throws(() => decodeTurnEventCursor("broken"), /Invalid/u);
});
