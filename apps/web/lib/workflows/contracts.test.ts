import assert from "node:assert/strict";
import test from "node:test";
import {
  createStarterWorkflowDefinition,
  validateWorkflowDefinition,
  WorkflowDefinitionError,
} from "./contracts";

test("starter workflow is a valid coarse executable graph", () => {
  const definition = validateWorkflowDefinition(createStarterWorkflowDefinition());
  assert.deepEqual(definition.nodes.map((node) => node.kind), ["trigger", "kestrel", "output"]);
});

test("workflow definitions reject cycles", () => {
  const definition = createStarterWorkflowDefinition();
  definition.edges.push({ id: "cycle", source: "kestrel-1", target: "trigger" });
  assert.throws(() => validateWorkflowDefinition(definition), WorkflowDefinitionError);
});

test("joins require two incoming branches", () => {
  const definition = createStarterWorkflowDefinition();
  definition.nodes.splice(2, 0, {
    id: "join-1",
    kind: "join",
    label: "Join",
    position: { x: 500, y: 120 },
    config: { mode: "all" },
  });
  definition.edges = [
    { id: "trigger-kestrel", source: "trigger", target: "kestrel-1" },
    { id: "kestrel-join", source: "kestrel-1", target: "join-1" },
    { id: "join-output", source: "join-1", target: "output" },
  ];
  assert.throws(
    () => validateWorkflowDefinition(definition),
    /needs at least two inputs/u,
  );
});

test("joins reject duplicate connections from the same predecessor", () => {
  const definition = createStarterWorkflowDefinition();
  definition.nodes.splice(2, 0, {
    id: "join-1",
    kind: "join",
    label: "Join",
    position: { x: 340, y: 440 },
    config: { mode: "all" },
  });
  definition.edges = [
    { id: "trigger-kestrel", source: "trigger", target: "kestrel-1" },
    { id: "kestrel-join-a", source: "kestrel-1", target: "join-1" },
    { id: "kestrel-join-b", source: "kestrel-1", target: "join-1" },
    { id: "join-output", source: "join-1", target: "output" },
  ];

  assert.throws(
    () => validateWorkflowDefinition(definition),
    /Connection from "kestrel-1" to "join-1" is duplicated/u,
  );
});

test("scheduled triggers require cron and timezone", () => {
  const definition = createStarterWorkflowDefinition();
  definition.nodes[0] = {
    id: "trigger",
    kind: "trigger",
    label: "Schedule",
    position: { x: 40, y: 120 },
    config: { mode: "schedule" },
  };
  assert.throws(
    () => validateWorkflowDefinition(definition),
    /cron expression and time zone/u,
  );
});
