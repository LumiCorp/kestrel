import assert from "node:assert/strict";
import test from "node:test";
import {
  agentProgressSummary,
  isTerminalThreadTurnStatus,
} from "./activity-presentation";

test("only completed, failed, and cancelled turns are terminal", () => {
  assert.equal(isTerminalThreadTurnStatus("queued"), false);
  assert.equal(isTerminalThreadTurnStatus("running"), false);
  assert.equal(isTerminalThreadTurnStatus("waiting_for_input"), false);
  assert.equal(isTerminalThreadTurnStatus("completed"), true);
  assert.equal(isTerminalThreadTurnStatus("failed"), true);
  assert.equal(isTerminalThreadTurnStatus("cancelled"), true);
  assert.equal(isTerminalThreadTurnStatus(undefined), false);
});

test("Agent progress summary uses an exact update count", () => {
  assert.equal(agentProgressSummary(1), "Agent progress · 1 update");
  assert.equal(agentProgressSummary(3), "Agent progress · 3 updates");
});
