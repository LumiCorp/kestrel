import test from "node:test";
import assert from "node:assert/strict";

import { FRESH_TURN_AGENT_CONTROL_KEYS } from "../../src/engine/ExecutionEngine.js";

test("fresh user turns clear stale goal and evidence state", () => {
  assert.equal(FRESH_TURN_AGENT_CONTROL_KEYS.includes("goal"), true);
  assert.equal((FRESH_TURN_AGENT_CONTROL_KEYS as readonly string[]).includes("workingPlan"), false);
  assert.equal((FRESH_TURN_AGENT_CONTROL_KEYS as readonly string[]).includes("planDocument"), false);
  assert.equal((FRESH_TURN_AGENT_CONTROL_KEYS as readonly string[]).includes("evidenceLedger"), false);
  assert.equal(FRESH_TURN_AGENT_CONTROL_KEYS.includes("latestEvidenceDelta"), true);
  assert.equal(FRESH_TURN_AGENT_CONTROL_KEYS.includes("observations"), true);
});

test("fresh user turns clear stale loop-stall control state", () => {
  assert.equal((FRESH_TURN_AGENT_CONTROL_KEYS as readonly string[]).includes("loopStall"), true);
});
