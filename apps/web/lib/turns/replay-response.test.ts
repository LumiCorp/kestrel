import assert from "node:assert/strict";
import { isDurableTurnReplayComplete } from "./replay-status";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "a waiting durable turn closes its current replay stream", () => {
  assert.equal(isDurableTurnReplayComplete("waiting_for_input"), true);
  assert.equal(isDurableTurnReplayComplete("completed"), true);
  assert.equal(isDurableTurnReplayComplete("failed"), true);
  assert.equal(isDurableTurnReplayComplete("cancelled"), true);
  assert.equal(isDurableTurnReplayComplete("queued"), false);
  assert.equal(isDurableTurnReplayComplete("running"), false);
});
