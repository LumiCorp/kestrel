import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRunnerExternalApprovalBindingV1,
  serializeCanonicalApprovalPayload,
} from "../src/index.js";

const binding = {
  version: "runner_external_approval_binding_v1",
  approvalId: "approval-1",
  threadId: "thread-1",
  runId: "run-1",
  actionKey: "hosted.tool",
  payloadHash: `sha256:${"a".repeat(64)}`,
  toolClass: "external_side_effect",
  capabilities: ["mcp.invoke", "network.call"],
  authorityKind: "hosted_mcp_grant",
  authorityRevision: "grant-1",
  requestedAt: "2026-08-03T12:00:00.000Z",
  expiresAt: "2026-08-03T12:05:00.000Z",
} as const;

test("external approval binding parser accepts the strict canonical contract", () => {
  assert.deepEqual(parseRunnerExternalApprovalBindingV1(binding), binding);
});

test("external approval binding parser rejects malformed hashes and unknown fields", () => {
  assert.throws(
    () => parseRunnerExternalApprovalBindingV1({ ...binding, payloadHash: "ABC" }),
    /sha256:<64 lowercase hex>/u,
  );
  assert.throws(
    () => parseRunnerExternalApprovalBindingV1({ ...binding, callerCapability: true }),
    /unknown field 'callerCapability'/u,
  );
});

test("canonical approval payload serialization sorts object fields exactly", () => {
  assert.equal(
    serializeCanonicalApprovalPayload({ z: 1, nested: { b: true, a: ["x", null] }, a: "first" }),
    '{"a":"first","nested":{"a":["x",null],"b":true},"z":1}',
  );
  assert.throws(
    () => serializeCanonicalApprovalPayload({ value: undefined }),
    /must not be undefined/u,
  );
});
