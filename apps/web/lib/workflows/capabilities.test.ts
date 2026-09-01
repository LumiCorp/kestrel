import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWorkflowCapability,
  WORKFLOW_NATIVE_WORKSPACE_TOOL_IDS,
} from "./capabilities";

test("workflow capability classification is server-owned and consequence based", () => {
  assert.equal(classifyWorkflowCapability({ runtimeName: "internet.search", accessMode: "read" }), "native");
  assert.equal(classifyWorkflowCapability({ runtimeName: "research.status", accessMode: "status" }), "native");
  assert.equal(classifyWorkflowCapability({ runtimeName: "email.send", accessMode: "write" }), "action");
  assert.equal(classifyWorkflowCapability({ runtimeName: "runtime.secret", accessMode: "internal" }), "hidden");
  assert.equal(classifyWorkflowCapability({ runtimeName: null, accessMode: "read" }), "hidden");
});

test("isolated-workspace create and update capabilities remain native", () => {
  for (const toolId of WORKFLOW_NATIVE_WORKSPACE_TOOL_IDS) {
    assert.equal(classifyWorkflowCapability({ runtimeName: toolId, accessMode: "write" }), "native");
  }
});
