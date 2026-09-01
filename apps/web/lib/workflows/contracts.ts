import { z } from "zod";

export const WORKFLOW_NODE_KINDS = [
  "trigger",
  "kestrel",
  "tool",
  "gate",
  "join",
  "output",
] as const;

export const workflowNodeKindSchema = z.enum(WORKFLOW_NODE_KINDS);

const positionSchema = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();

const baseNodeSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  position: positionSchema,
});

const workflowActionInputBindingSchema = z.object({
  kind: z.literal("kestrel_response_text"),
  sourceNodeId: z.string().trim().min(1).max(80),
}).strict();

export type WorkflowActionInputBinding = z.infer<typeof workflowActionInputBindingSchema>;

export const workflowNodeSchema = z.discriminatedUnion("kind", [
  baseNodeSchema.extend({
    kind: z.literal("trigger"),
    config: z
      .object({
        mode: z.enum(["manual", "schedule"]),
        cronExpression: z.string().trim().min(1).max(200).optional(),
        timeZone: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
  }),
  baseNodeSchema.extend({
    kind: z.literal("kestrel"),
    config: z
      .object({ instructions: z.string().trim().min(1).max(20_000) })
      .strict(),
  }),
  baseNodeSchema.extend({
    kind: z.literal("tool"),
    config: z
      .object({
        toolName: z.string().trim().min(1).max(240),
        input: z.record(z.string(), z.unknown()),
        inputBindings: z.record(z.string().regex(/^\/(?:[^~\/]|~[01])+(?:\/(?:[^~\/]|~[01])+)*$/u), workflowActionInputBindingSchema).default({}),
      })
      .strict(),
  }),
  baseNodeSchema.extend({
    kind: z.literal("gate"),
    config: z
      .object({
        path: z.string().trim().max(500),
        operator: z.enum(["exists", "equals", "not_equals"]),
        value: z.unknown().optional(),
      })
      .strict(),
  }),
  baseNodeSchema.extend({
    kind: z.literal("join"),
    config: z.object({ mode: z.literal("all") }).strict(),
  }),
  baseNodeSchema.extend({
    kind: z.literal("output"),
    config: z.object({}).strict(),
  }),
]);

export const workflowEdgeSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    source: z.string().trim().min(1).max(80),
    target: z.string().trim().min(1).max(80),
  })
  .strict();

const rawDefinitionSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(workflowNodeSchema).min(2).max(100),
    edges: z.array(workflowEdgeSchema).min(1).max(300),
  })
  .strict();

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowDefinition = z.infer<typeof rawDefinitionSchema>;

export class WorkflowDefinitionError extends Error {
  readonly code = "WORKFLOW_DEFINITION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkflowDefinitionError";
  }
}

function jsonPointerSegments(pointer: string) {
  return pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function hasJsonPointer(value: Record<string, unknown>, pointer: string) {
  let current: unknown = value;
  for (const segment of jsonPointerSegments(pointer)) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

export function validateWorkflowDefinition(input: unknown): WorkflowDefinition {
  const definition = rawDefinitionSchema.parse(input);
  const nodeIds = new Set<string>();
  for (const node of definition.nodes) {
    if (nodeIds.has(node.id)) {
      throw new WorkflowDefinitionError(`Node ID "${node.id}" is duplicated.`);
    }
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  const connections = new Set<string>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of definition.nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id)) {
      throw new WorkflowDefinitionError(`Edge ID "${edge.id}" is duplicated.`);
    }
    edgeIds.add(edge.id);
    if (!(nodeIds.has(edge.source) && nodeIds.has(edge.target))) {
      throw new WorkflowDefinitionError(`Edge "${edge.id}" references an unknown node.`);
    }
    if (edge.source === edge.target) {
      throw new WorkflowDefinitionError(`Node "${edge.source}" cannot connect to itself.`);
    }
    const connection = `${edge.source}\u0000${edge.target}`;
    if (connections.has(connection)) {
      throw new WorkflowDefinitionError(
        `Connection from "${edge.source}" to "${edge.target}" is duplicated.`,
      );
    }
    connections.add(connection);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const reaches = (sourceNodeId: string, targetNodeId: string) => {
    const pending = [sourceNodeId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === targetNodeId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(outgoing.get(current) ?? []));
    }
    return false;
  };

  const triggers = definition.nodes.filter((node) => node.kind === "trigger");
  const outputs = definition.nodes.filter((node) => node.kind === "output");
  if (triggers.length !== 1) {
    throw new WorkflowDefinitionError("A workflow must have exactly one trigger.");
  }
  if (outputs.length !== 1) {
    throw new WorkflowDefinitionError("A workflow must have exactly one output.");
  }
  if ((incoming.get(triggers[0]!.id) ?? 0) !== 0) {
    throw new WorkflowDefinitionError("The trigger cannot have incoming connections.");
  }
  if ((outgoing.get(outputs[0]!.id)?.length ?? 0) !== 0) {
    throw new WorkflowDefinitionError("The output cannot have outgoing connections.");
  }
  for (const node of definition.nodes) {
    if (node.kind !== "trigger" && (incoming.get(node.id) ?? 0) === 0) {
      throw new WorkflowDefinitionError(`Node "${node.label}" must have an incoming connection.`);
    }
    if (node.kind !== "output" && (outgoing.get(node.id)?.length ?? 0) === 0) {
      throw new WorkflowDefinitionError(`Node "${node.label}" must have an outgoing connection.`);
    }
    if (node.kind === "join" && (incoming.get(node.id) ?? 0) < 2) {
      throw new WorkflowDefinitionError(`Join "${node.label}" needs at least two inputs.`);
    }
    if (node.kind === "tool") {
      if (node.config.toolName === "exec_command" && Object.keys(node.config.inputBindings).length > 0) {
        throw new WorkflowDefinitionError("Run command Actions cannot use dynamic values.");
      }
      for (const [pointer, binding] of Object.entries(node.config.inputBindings)) {
        const source = definition.nodes.find(candidate => candidate.id === binding.sourceNodeId);
        if (source?.kind !== "kestrel") throw new WorkflowDefinitionError(`Action "${node.label}" must use output from a Kestrel step.`);
        if (!reaches(binding.sourceNodeId, node.id)) throw new WorkflowDefinitionError(`Action "${node.label}" can only use output from an upstream Kestrel step.`);
        if (hasJsonPointer(node.config.input, pointer)) throw new WorkflowDefinitionError(`Action "${node.label}" cannot set ${pointer} as both a fixed and dynamic value.`);
      }
    }
    if (
      node.kind === "trigger" &&
      node.config.mode === "schedule" &&
      !(node.config.cronExpression && node.config.timeZone)
    ) {
      throw new WorkflowDefinitionError("A scheduled trigger needs a cron expression and time zone.");
    }
  }

  const ready = definition.nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.shift()!;
    visited += 1;
    for (const target of outgoing.get(current) ?? []) {
      const remaining = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }
  if (visited !== definition.nodes.length) {
    throw new WorkflowDefinitionError("Workflow connections must form an acyclic graph.");
  }

  return definition;
}

export function workflowTrigger(definition: WorkflowDefinition) {
  return definition.nodes.find((node) => node.kind === "trigger")!;
}

export function createStarterWorkflowDefinition(): WorkflowDefinition {
  return {
    version: 1,
    nodes: [
      {
        id: "trigger",
        kind: "trigger",
        label: "Run manually",
        position: { x: 340, y: 40 },
        config: { mode: "manual" },
      },
      {
        id: "kestrel-1",
        kind: "kestrel",
        label: "Kestrel step",
        position: { x: 340, y: 240 },
        config: { instructions: "Describe the work Kestrel should complete." },
      },
      {
        id: "output",
        kind: "output",
        label: "Workflow output",
        position: { x: 340, y: 440 },
        config: {},
      },
    ],
    edges: [
      { id: "trigger-kestrel-1", source: "trigger", target: "kestrel-1" },
      { id: "kestrel-1-output", source: "kestrel-1", target: "output" },
    ],
  };
}
