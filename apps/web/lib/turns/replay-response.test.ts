import assert from "node:assert/strict";
import test from "node:test";
import { isDurableTurnReplayComplete } from "./replay-status";

test("a waiting durable turn closes its current replay stream", () => {
  assert.equal(isDurableTurnReplayComplete("waiting_for_input"), true);
  assert.equal(isDurableTurnReplayComplete("completed"), true);
  assert.equal(isDurableTurnReplayComplete("failed"), true);
  assert.equal(isDurableTurnReplayComplete("cancelled"), true);
  assert.equal(isDurableTurnReplayComplete("queued"), false);
  assert.equal(isDurableTurnReplayComplete("running"), false);
});
