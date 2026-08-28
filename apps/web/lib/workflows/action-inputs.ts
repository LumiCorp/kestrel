import type { WorkflowDefinition, WorkflowNode } from "./contracts";

function pointerSegments(pointer: string) {
  return pointer.slice(1).split("/").map((value) => value.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function setPointer(input: Record<string, unknown>, pointer: string, value: unknown) {
  const result = structuredClone(input);
  const segments = pointerSegments(pointer);
  let current = result;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    current[segment] = next && typeof next === "object" && !Array.isArray(next) ? next : {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
  return result;
}

export function resolveWorkflowActionInput(
  node: Extract<WorkflowNode, { kind: "tool" }>,
  outputs: ReadonlyMap<string, unknown>,
  definition: WorkflowDefinition,
) {
  let resolved = structuredClone(node.config.input);
  for (const [pointer, binding] of Object.entries(node.config.inputBindings)) {
    const output = outputs.get(binding.sourceNodeId);
    const text = output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>).text
      : undefined;
    if (typeof text !== "string" || !text.trim()) {
      const source = definition.nodes.find((candidate) => candidate.id === binding.sourceNodeId);
      const field = pointerSegments(pointer).at(-1)?.replaceAll("_", " ") ?? "text field";
      throw Object.assign(
        new Error(`Action "${node.label}" needs a response from "${source?.label ?? "the upstream Kestrel step"}" for ${field}.`),
        { code: "WORKFLOW_ACTION_INPUT_INVALID" },
      );
    }
    resolved = setPointer(resolved, pointer, text);
  }
  return resolved;
}
