import assert from "node:assert/strict";
import test from "node:test";
import { workflowStepEvidence } from "./evidence";

test("step evidence exposes the selected model and internal tool calls", () => {
  const evidence = workflowStepEvidence({
    model: "openai/gpt-5",
    parts: [
      { type: "tool-weather", toolCallId: "call-1", state: "output-available", input: { city: "Boston" }, output: { temp: 72 } },
      { type: "text", text: "It is warm." },
    ],
  });
  assert.equal(evidence.model, "openai/gpt-5");
  assert.equal(evidence.text, "It is warm.");
  assert.deepEqual(evidence.toolCalls, [{
    toolCallId: "call-1",
    toolName: "weather",
    state: "output-available",
    input: { city: "Boston" },
    output: { temp: 72 },
  }]);
});
