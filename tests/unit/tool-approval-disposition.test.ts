import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRememberedThreadApprovalV1,
  resolveToolApprovalDispositionV1,
} from "../../src/mode/contracts.js";

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
    "runtime_strict",
  );
  assert.equal(
    resolveToolApprovalDispositionV1({
      environment: "ask",
      subject: "ask",
      authority,
    }).reasonCode,
    "subject_restriction",
  );
  assert.equal(
    resolveToolApprovalDispositionV1({
      environment: "ask",
      minimum: "ask",
      authority,
    }).reasonCode,
    "tool_minimum",
  );
});

test("remembered evidence changes only eligible Environment or Project Ask First", () => {
  const eligible = resolveToolApprovalDispositionV1({
    environment: "ask",
    authority,
  });
  assert.deepEqual(
    applyRememberedThreadApprovalV1({
      disposition: eligible,
      exactEvidenceMatch: true,
      currentPolicy: { environment: "ask", minimum: "auto" },
    }),
    { mode: "auto", reasonCode: "remembered_thread", authority },
  );
  assert.deepEqual(
    applyRememberedThreadApprovalV1({
      disposition: eligible,
      exactEvidenceMatch: false,
      currentPolicy: { environment: "ask", minimum: "auto" },
    }),
    eligible,
  );

  const eligibleProjectAsk = resolveToolApprovalDispositionV1({
    environment: "auto",
    project: "ask",
    authority,
  });
  assert.deepEqual(
    applyRememberedThreadApprovalV1({
      disposition: eligibleProjectAsk,
      exactEvidenceMatch: true,
      currentPolicy: { environment: "auto", project: "ask", minimum: "auto" },
    }),
    { mode: "auto", reasonCode: "remembered_thread", authority },
  );

  for (const currentPolicy of [
    { environment: "auto" as const, subject: "ask" as const, minimum: "auto" as const },
    { environment: "auto" as const, minimum: "ask" as const },
    { environment: "auto" as const, minimum: "auto" as const, strictApprovalPerCall: true },
    { environment: "deny" as const, minimum: "auto" as const },
    { environment: "auto" as const, minimum: "auto" as const },
    { environment: "ask" as const, subject: "ask" as const, minimum: "auto" as const },
    { environment: "ask" as const, minimum: "ask" as const },
    { environment: "ask" as const, minimum: "auto" as const, strictApprovalPerCall: true },
  ]) {
    const disposition = resolveToolApprovalDispositionV1({
      ...currentPolicy,
      authority,
    });
    assert.deepEqual(
      applyRememberedThreadApprovalV1({
        disposition,
        exactEvidenceMatch: true,
        currentPolicy,
      }),
      disposition,
    );
  }
});
