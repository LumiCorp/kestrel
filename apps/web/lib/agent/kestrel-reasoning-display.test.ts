import assert from "node:assert/strict";
import test from "node:test";
import {
  getReasoningTriggerLabel,
  shouldAutoCloseReasoning,
} from "@/lib/agent/kestrel-reasoning-display";

test("getReasoningTriggerLabel reflects terminal failure statuses", () => {
  assert.equal(
    getReasoningTriggerLabel({
      duration: 4,
      isStreaming: false,
      terminalStatus: "failed",
    }),
    "Failed"
  );
  assert.equal(
    getReasoningTriggerLabel({
      duration: 4,
      isStreaming: false,
      terminalStatus: "cancelled",
    }),
    "Cancelled"
  );
  assert.equal(
    getReasoningTriggerLabel({
      duration: 4,
      isStreaming: false,
      terminalStatus: "contract_failure",
    }),
    "Interrupted"
  );
});

test("getReasoningTriggerLabel keeps completed behavior unchanged", () => {
  assert.equal(
    getReasoningTriggerLabel({
      duration: 0,
      isStreaming: true,
      terminalStatus: "completed",
    }),
    "Thinking"
  );
  assert.equal(
    getReasoningTriggerLabel({
      duration: 7,
      isStreaming: false,
      terminalStatus: "completed",
    }),
    "7s"
  );
});

test("getReasoningTriggerLabel identifies a run waiting for the user", () => {
  assert.equal(
    getReasoningTriggerLabel({
      duration: 7,
      isStreaming: false,
      terminalStatus: "waiting",
    }),
    "Waiting"
  );
  assert.equal(shouldAutoCloseReasoning("waiting"), true);
});

test("shouldAutoCloseReasoning keeps terminal failures open", () => {
  assert.equal(shouldAutoCloseReasoning("completed"), true);
  assert.equal(shouldAutoCloseReasoning("failed"), false);
  assert.equal(shouldAutoCloseReasoning("cancelled"), false);
  assert.equal(shouldAutoCloseReasoning("contract_failure"), false);
});
