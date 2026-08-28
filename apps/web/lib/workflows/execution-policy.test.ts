import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowStepEvidence } from "./evidence";
import {
  assertWorkflowToolsAvailable,
  validateExplicitToolCallEvidence,
} from "./execution-policy";
import { createStarterWorkflowDefinition } from "./contracts";

const expectedInput = { repository: "kestrel", labels: ["runtime"] };

function evidence(
  toolCalls: WorkflowStepEvidence["toolCalls"],
): WorkflowStepEvidence {
  return { model: "openai/gpt-5.6", text: "done", toolCalls };
}

function call(
  overrides: Partial<WorkflowStepEvidence["toolCalls"][number]> = {},
): WorkflowStepEvidence["toolCalls"][number] {
  return {
    toolCallId: "call-1",
    toolName: "github.issue.create",
    state: "output-available",
    input: expectedInput,
    output: { number: 42 },
    ...overrides,
  };
}

test("explicit tool evidence accepts one exact completed call", () => {
  assert.deepEqual(
    validateExplicitToolCallEvidence({
      toolName: "github.issue.create",
      expectedInput,
      evidence: evidence([call()]),
    }),
    { valid: true },
  );
});

test("explicit tool evidence rejects missing, duplicate, and extra calls", () => {
  for (const toolCalls of [
    [],
    [call(), call({ toolCallId: "call-2" })],
    [call(), call({ toolCallId: "call-2", toolName: "email.send" })],
  ]) {
    assert.equal(
      validateExplicitToolCallEvidence({
        toolName: "github.issue.create",
        expectedInput,
        evidence: evidence(toolCalls),
      }).valid,
      false,
    );
  }
});

test("explicit tool evidence rejects the wrong tool or changed input", () => {
  for (const toolCall of [
    call({ toolName: "email.send" }),
    call({ input: { repository: "other" } }),
  ]) {
    assert.equal(
      validateExplicitToolCallEvidence({
        toolName: "github.issue.create",
        expectedInput,
        evidence: evidence([toolCall]),
      }).valid,
      false,
    );
  }
});

test("explicit tool evidence rejects errored and non-terminal calls", () => {
  for (const toolCall of [
    call({ state: "output-error", error: "denied" }),
    call({ state: "input-available", output: undefined }),
  ]) {
    assert.equal(
      validateExplicitToolCallEvidence({
        toolName: "github.issue.create",
        expectedInput,
        evidence: evidence([toolCall]),
      }).valid,
      false,
    );
  }
});

test("workflow definitions reject tools outside project-effective access", () => {
  const starter = createStarterWorkflowDefinition();
  const definition = {
    ...starter,
    nodes: starter.nodes.map((node) =>
      node.id === "kestrel-1"
        ? {
            id: node.id,
            label: "Create issue",
            kind: "tool" as const,
            position: node.position,
            config: {
              toolName: "github.issue.create",
              input: { title: "Fix workflow" },
              inputBindings: {},
            },
          }
        : node,
    ),
  };
  assert.throws(
    () => assertWorkflowToolsAvailable(definition, new Set()),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "WORKFLOW_TOOL_UNAVAILABLE",
      ),
  );
  assert.equal(
    assertWorkflowToolsAvailable(
      definition,
      new Set(["github.issue.create"]),
    ),
    definition,
  );
});
