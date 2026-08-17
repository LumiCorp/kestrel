import assert from "node:assert/strict";
import test from "node:test";

import { resolveToolApprovalDispositionV1 } from "../../src/mode/contracts.js";

const authority = {
  kind: "hosted_app_policy" as const,
  revision: "revision-1",
};

test("approval disposition resolves the full narrowing precedence", () => {
  assert.deepEqual(
    resolveToolApprovalDispositionV1({ environment: "auto", authority }),
    { mode: "auto", reasonCode: "environment_policy", authority },
  );
  assert.equal(
    resolveToolApprovalDispositionV1({
      environment: "auto",
      project: "ask",
      authority,
    }).reasonCode,
    "project_restriction",
  );
  assert.equal(
    resolveToolApprovalDispositionV1({
      environment: "auto",
      project: "auto",
      subject: "ask",
      authority,
    }).reasonCode,
    "subject_restriction",
  );
  assert.equal(
    resolveToolApprovalDispositionV1({
      environment: "auto",
      minimum: "ask",
      authority,
    }).reasonCode,
    "tool_minimum",
  );
  assert.equal(
    resolveToolApprovalDispositionV1({
      environment: "auto",
      strictApprovalPerCall: true,
      authority,
    }).reasonCode,
    "runtime_strict",
  );
});

test("approval disposition never lets a lower layer widen its ceiling", () => {
  assert.equal(
    resolveToolApprovalDispositionV1({
      environment: "ask",
      project: "auto",
      subject: "auto",
      authority,
    }).mode,
    "ask",
  );
  assert.equal(
    resolveToolApprovalDispositionV1({
      environment: "deny",
      project: "auto",
      minimum: "auto",
      authority,
    }).mode,
    "deny",
  );
  assert.equal(
    resolveToolApprovalDispositionV1({
      environment: "ask",
      strictApprovalPerCall: true,
      authority,
    }).reasonCode,
    "environment_policy",
  );
});
