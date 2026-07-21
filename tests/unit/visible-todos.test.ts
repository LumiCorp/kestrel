import assert from "node:assert/strict";

import {
  analyzeVisibleTodoFinalizeReadiness,
  analyzeVisibleTodosCompletion,
  normalizeVisibleTodoResidualGapData,
  normalizeVisibleTodoState,
  renderVisibleTodosForModel,
  validateVisibleTodoState,
} from "../../src/runtime/visibleTodos.js";
import { validateRuntimeSessionState } from "../../src/runtime/state.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "visible todo state validates the minimal model-owned checklist", () => {
  const result = validateVisibleTodoState({
    objective: "Build the newsletter page",
    items: [
      {
        id: "scaffold-app",
        text: "Scaffold the app",
        status: "done",
      },
      {
        id: "replace-page",
        text: "Replace the starter page",
        status: "in_progress",
        note: "Build output still needs a rerun.",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value.items.map((item) => item.status) : [], ["done", "in_progress"]);
});

contractTest("runtime.hermetic", "visible todo state rejects ledger-like runtime bookkeeping fields", () => {
  const result = validateVisibleTodoState({
    objective: "Build the app",
    items: [
      {
        id: "verify",
        text: "Run build",
        status: "done",
        evidenceRefs: ["ev_build"],
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.path, "items.0.evidenceRefs");
});

contractTest("runtime.hermetic", "visible todos render plain current work", () => {
  const rendered = renderVisibleTodosForModel({
    objective: "Build the planner",
    items: [
      { id: "scaffold", text: "Scaffold Vite app", status: "done" },
      { id: "ui", text: "Build the planner UI", status: "in_progress" },
      { id: "build", text: "Run build", status: "pending" },
    ],
  });

  assert.equal(rendered, [
    "Current work:",
    "- done: Scaffold Vite app",
    "- in_progress: Build the planner UI",
    "- pending: Run build",
  ].join("\n"));
  assert.doesNotMatch(rendered ?? "", /evidenceRefs|attempts/u);
});

contractTest("runtime.hermetic", "visible todo completion analysis is checklist-only", () => {
  const todos = normalizeVisibleTodoState({
    objective: "Build the app",
    items: [
      { id: "scaffold", text: "Scaffold", status: "done" },
      { id: "build", text: "Run build", status: "blocked", note: "Build command fails." },
    ],
  });

  const analysis = analyzeVisibleTodosCompletion(todos);
  assert.equal(analysis.complete, false);
  assert.equal(analysis.openItems.length, 1);
  assert.equal(analysis.blockedItems[0]?.id, "build");
});

contractTest("runtime.hermetic", "visible todo finalize readiness treats documented blocked gaps as residual", () => {
  const todos = normalizeVisibleTodoState({
    objective: "Build the app",
    items: [
      { id: "build", text: "Run build", status: "done" },
      { id: "browser", text: "Exercise browser E2E", status: "blocked", note: "Browser E2E was not directly exercised." },
    ],
  });
  const residualGap = normalizeVisibleTodoResidualGapData({
    openGap: "Browser E2E was not directly exercised.",
    residualTodoIds: ["browser"],
  });

  const analysis = analyzeVisibleTodoFinalizeReadiness({
    todos,
    ...(residualGap !== undefined ? { residualGap } : {}),
  });

  assert.equal(analysis.complete, true);
  assert.equal(analysis.residualOpenItems[0]?.id, "browser");
  assert.equal(todos?.items[1]?.status, "blocked");
  assert.equal(todos?.items[1]?.note, "Browser E2E was not directly exercised.");
});

contractTest("runtime.hermetic", "visible todo finalize readiness keeps actionable work blocking", () => {
  const todos = normalizeVisibleTodoState({
    objective: "Build the app",
    items: [
      { id: "build", text: "Run build", status: "pending" },
      { id: "browser", text: "Exercise browser E2E", status: "blocked", note: "Browser E2E was not directly exercised." },
    ],
  });
  const residualGap = normalizeVisibleTodoResidualGapData({
    openGap: "Browser E2E was not directly exercised.",
  });

  const analysis = analyzeVisibleTodoFinalizeReadiness({
    todos,
    ...(residualGap !== undefined ? { residualGap } : {}),
  });

  assert.equal(analysis.complete, false);
  assert.equal(analysis.blockingOpenItems[0]?.id, "build");
});

contractTest("runtime.hermetic", "runtime state validation accepts visible todos", () => {
  const error = validateRuntimeSessionState({
    runtime: { schemaVersion: 2 },
    agent: {
      observations: [],
      exec: {},
      assistantText: null,
      visibleTodos: {
        objective: "Build the app",
        items: [{ id: "build", text: "Run build", status: "pending" }],
      },
    },
  });

  assert.equal(error, undefined);
});
