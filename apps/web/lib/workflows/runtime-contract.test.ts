import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const runtime = fs.readFileSync(path.join(directory, "runtime.ts"), "utf8");
const queue = fs.readFileSync(path.join(directory, "../turns/queue.ts"), "utf8");
const runView = fs.readFileSync(
  path.join(directory, "../../components/workflows/workflow-run-client.tsx"),
  "utf8",
);

test("workflow work steps enter the ordinary durable Kestrel runtime", () => {
  assert.match(runtime, /createDurableThreadTurnInTransaction/u);
  assert.match(runtime, /requestedInteractionMode: "build"/u);
  assert.match(runtime, /noninteractive: true/u);
  assert.match(runtime, /WORKFLOW_INTERACTION_REQUIRED/u);
  assert.match(runtime, /attentionCode: code\.slice/u);
  assert.match(runtime, /enabled: false/u);
  assert.match(runtime, /WORKFLOW_TOOL_CONTRACT_VIOLATION/u);
});

test("worker maintenance advances active and scheduled workflows", () => {
  assert.match(queue, /claimDueProjectWorkflowRuns/u);
  assert.match(queue, /listActiveProjectWorkflowRunIds/u);
  assert.match(queue, /advanceProjectWorkflowRun/u);
});

test("expanding a coarse step exposes model, tools, and its child task", () => {
  assert.match(runView, /<details/u);
  assert.match(runView, /Internal tool calls/u);
  assert.match(runView, /evidence\.model/u);
  assert.match(runView, /Open Kestrel task/u);
});

test("run evidence exposes the structured input and output at every DAG node", () => {
  assert.match(runView, /Step input/u);
  assert.match(runView, /Recorded output/u);
});

test("the workflow run graph has a definite responsive height", () => {
  assert.match(runView, /data-testid="workflow-run-canvas"/u);
  assert.match(runView, /h-\[min\(70vh,760px\)\] min-h-130/u);
});
