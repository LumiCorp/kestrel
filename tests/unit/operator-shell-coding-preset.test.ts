import test from "node:test";
import assert from "node:assert/strict";

import {
  listOperatorProfilePresets,
  listOperatorTaskTemplates,
} from "../../src/operatorShell.js";

test("coding preset copy advertises inspect-implement-validate host-shell posture", () => {
  const coding = listOperatorProfilePresets().find((preset) => preset.id === "coding");
  assert.notEqual(coding, undefined);
  assert.match(coding?.description ?? "", /workspace inspection/i);
  assert.match(coding?.description ?? "", /validation/i);
  assert.match(coding?.description ?? "", /host-shell workflows/i);
});

test("coding task template prompt seed includes inspection, validation, and host-shell allowance", () => {
  const codingTask = listOperatorTaskTemplates().find((template) => template.id === "coding-task");
  assert.notEqual(codingTask, undefined);
  assert.match(codingTask?.description ?? "", /Inspect, implement, validate/i);
  assert.match(codingTask?.promptSeed ?? "", /Inspect the workspace/i);
  assert.match(codingTask?.promptSeed ?? "", /run relevant validation/i);
  assert.match(codingTask?.promptSeed ?? "", /host-shell workflows when permitted/i);
});
