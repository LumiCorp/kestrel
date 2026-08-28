import { isDeepStrictEqual } from "node:util";
import type { WorkflowDefinition } from "./contracts";
import type { WorkflowStepEvidence } from "./evidence";

export function assertWorkflowToolsAvailable(
  definition: WorkflowDefinition,
  allowedToolNames: ReadonlySet<string>,
) {
  const unavailable = definition.nodes.find(
    (node) =>
      node.kind === "tool" && !allowedToolNames.has(node.config.toolName),
  );
  if (!unavailable || unavailable.kind !== "tool") return definition;
  throw Object.assign(
    new Error(
      `Action "${unavailable.label}" uses ${unavailable.config.toolName}, which is not available in this Project.`,
    ),
    {
      code: "WORKFLOW_TOOL_UNAVAILABLE",
      nodeId: unavailable.id,
      toolName: unavailable.config.toolName,
    },
  );
}

export function validateExplicitToolCallEvidence(input: {
  toolName: string;
  expectedInput: Record<string, unknown>;
  evidence: WorkflowStepEvidence;
}): { valid: true } | { valid: false; message: string } {
  const calls = input.evidence.toolCalls;
  if (calls.length !== 1) {
    return {
      valid: false,
      message: `Expected exactly one ${input.toolName} call, but recorded ${calls.length}.`,
    };
  }
  const [call] = calls;
  if (call?.toolName !== input.toolName) {
    return {
      valid: false,
      message: `Expected ${input.toolName}, but recorded ${call?.toolName ?? "an unnamed tool"}.`,
    };
  }
  if (!isDeepStrictEqual(call.input, input.expectedInput)) {
    return {
      valid: false,
      message: `${input.toolName} was called with input that differs from the configured JSON.`,
    };
  }
  if (call.state !== "output-available" || call.error) {
    return {
      valid: false,
      message: `${input.toolName} did not finish with an available output.`,
    };
  }
  return { valid: true };
}
