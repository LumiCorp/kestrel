import assert from "node:assert/strict";

import { parseOperatorControlPolicyFields } from "../../src/orchestration/OperatorControlValidation.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "parseOperatorControlPolicyFields accepts shared operator policy fields", () => {
  const parsed = parseOperatorControlPolicyFields({
    allowToolClasses: ["read_only", "sandboxed_only"],
    allowCapabilities: ["workspace.read"],
  });

  assert.deepEqual(parsed, {
      ok: true,
      value: {
      allowToolClasses: ["read_only", "sandboxed_only"],
      allowCapabilities: ["workspace.read"],
    },
  });
});

contractTest("runtime.hermetic", "parseOperatorControlPolicyFields rejects invalid tool classes with field evidence", () => {
  const parsed = parseOperatorControlPolicyFields({
    allowToolClasses: ["read_only", "network"],
  });

  assert.deepEqual(parsed, {
    ok: false,
    field: "allowToolClasses",
    message: "allowToolClasses contains an invalid tool class",
  });
});

contractTest("runtime.hermetic", "parseOperatorControlPolicyFields rejects blank capability entries with field evidence", () => {
  const parsed = parseOperatorControlPolicyFields({
    allowCapabilities: ["workspace.read", " "],
  });

  assert.deepEqual(parsed, {
    ok: false,
    field: "allowCapabilities",
    message: "allowCapabilities must contain non-empty strings",
  });
});
