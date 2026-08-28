import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinition } from "./contracts";
import { resolveWorkflowActionInput } from "./action-inputs";

const definition: WorkflowDefinition = {
  version: 1,
  nodes: [
    { id: "trigger", kind: "trigger", label: "Run manually", position: { x: 0, y: 0 }, config: { mode: "manual" } },
    { id: "research", kind: "kestrel", label: "Research company", position: { x: 0, y: 100 }, config: { instructions: "Research it" } },
    {
      id: "action",
      kind: "tool",
      label: "Create record",
      position: { x: 0, y: 200 },
      config: {
        toolName: "records.create",
        input: { destination: "inbox", details: { priority: "normal" } },
        inputBindings: { "/details/summary": { kind: "kestrel_response_text", sourceNodeId: "research" } },
      },
    },
    { id: "output", kind: "output", label: "Result", position: { x: 0, y: 300 }, config: {} },
  ],
  edges: [
    { id: "a", source: "trigger", target: "research" },
    { id: "b", source: "research", target: "action" },
    { id: "c", source: "action", target: "output" },
  ],
};

const action = definition.nodes[2];
if (action?.kind !== "tool") throw new Error("Action fixture is invalid.");

test("Action input resolution merges durable Kestrel response text into nested string fields", () => {
  assert.deepEqual(
    resolveWorkflowActionInput(action, new Map([["research", { text: "Acme is expanding." }]]), definition),
    { destination: "inbox", details: { priority: "normal", summary: "Acme is expanding." } },
  );
});

test("Action input resolution fails closed on empty Kestrel response text", () => {
  assert.throws(
    () => resolveWorkflowActionInput(action, new Map([["research", { text: "  " }]]), definition),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "WORKFLOW_ACTION_INPUT_INVALID"),
  );
});
