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

function workflowWithBoundAction() {
  const definition = createStarterWorkflowDefinition();
  definition.nodes.splice(2, 0, {
    id: "action-1",
    kind: "tool",
    label: "Create issue",
    position: { x: 340, y: 440 },
    config: {
      toolName: "github.issue.create",
      input: {},
      inputBindings: {
        "/title": { kind: "kestrel_response_text", sourceNodeId: "kestrel-1" },
      },
    },
  });
  definition.edges = [
    { id: "trigger-kestrel", source: "trigger", target: "kestrel-1" },
    { id: "kestrel-action", source: "kestrel-1", target: "action-1" },
    { id: "action-output", source: "action-1", target: "output" },
  ];
  return definition;
}

test("Action bindings accept an upstream Kestrel response and omit its fixed field", () => {
  assert.deepEqual(validateWorkflowDefinition(workflowWithBoundAction()), workflowWithBoundAction());
});

test("Action bindings reject downstream Kestrel sources", () => {
  const definition = workflowWithBoundAction();
  definition.edges = [
    { id: "trigger-action", source: "trigger", target: "action-1" },
    { id: "action-kestrel", source: "action-1", target: "kestrel-1" },
    { id: "kestrel-output", source: "kestrel-1", target: "output" },
  ];
  assert.throws(() => validateWorkflowDefinition(definition), /upstream Kestrel step/u);
});

test("Action bindings reject fixed and dynamic values for the same field", () => {
  const definition = workflowWithBoundAction();
  const action = definition.nodes.find((node) => node.id === "action-1");
  if (action?.kind !== "tool") throw new Error("Action fixture is missing.");
  action.config.input = { title: "Fixed title" };
  assert.throws(() => validateWorkflowDefinition(definition), /both a fixed and dynamic value/u);
});

test("Run command Actions reject every dynamic binding", () => {
  const definition = workflowWithBoundAction();
  const action = definition.nodes.find((node) => node.id === "action-1");
  if (action?.kind !== "tool") throw new Error("Action fixture is missing.");
  action.config.toolName = "exec_command";
  assert.throws(() => validateWorkflowDefinition(definition), /cannot use dynamic values/u);
});
