import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRememberedThreadApprovalV1,
  isRememberApprovalEligibleV1,
  parseHostedToolApprovalDecision,
  parseRememberedToolApprovalEvidenceSetV1,
  parseRunnerExternalApprovalBindingV1,
  parseRunnerExternalApprovalBindingV2,
  parseStableToolApprovalIdentityV1,
  resolveToolApprovalDispositionV1,
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

const policyAuthority = {
  kind: "hosted_app_policy",
  revision: "project-policy-v1",
} as const;

test("shared approval policy helpers preserve only Environment or Project Ask First", () => {
  const environmentAsk = resolveToolApprovalDispositionV1({
    environment: "ask",
    authority: policyAuthority,
  });
  assert.equal(
    isRememberApprovalEligibleV1({
      disposition: environmentAsk,
      currentPolicy: { environment: "ask", minimum: "auto" },
    }),
    true,
  );

  const projectAsk = resolveToolApprovalDispositionV1({
    environment: "auto",
    project: "ask",
    authority: policyAuthority,
  });
  assert.equal(projectAsk.reasonCode, "project_restriction");
  assert.deepEqual(
    applyRememberedThreadApprovalV1({
      disposition: projectAsk,
      exactEvidenceMatch: true,
      currentPolicy: {
        environment: "auto",
        project: "ask",
        minimum: "auto",
      },
    }),
    {
      mode: "auto",
      reasonCode: "remembered_thread",
      authority: policyAuthority,
    },
  );

  const subjectAsk = resolveToolApprovalDispositionV1({
    environment: "ask",
    subject: "ask",
    authority: policyAuthority,
  });
  assert.equal(
    isRememberApprovalEligibleV1({
      disposition: subjectAsk,
      currentPolicy: {
        environment: "ask",
        subject: "ask",
        minimum: "auto",
      },
    }),
    false,
  );
});

test("external approval binding parser accepts the strict canonical contract", () => {
  assert.deepEqual(parseRunnerExternalApprovalBindingV1(binding), binding);
});

test("new hosted approval contracts are strict, versioned, and empty-compatible", () => {
  const toolIdentity = parseStableToolApprovalIdentityV1({
    version: "stable_tool_approval_identity_v1",
    toolId: "hosted.tool",
    descriptorContractRevision: `sha256:${"b".repeat(64)}`,
    approvalAuthorityRevision: "authority-v2",
  });
  const bindingV2 = {
    version: "runner_external_approval_binding_v2",
    approvalId: "approval-2",
    preparedInvocationId: "prepared-2",
    threadId: "thread-1",
    actionKey: "hosted.tool",
    payloadHash: `sha256:${"c".repeat(64)}`,
    stableAuthorityFingerprint: `sha256:${"d".repeat(64)}`,
    stableToolIdentity: toolIdentity,
    requestingActor: {
      actorType: "end_user",
      actorId: "user-1",
      tenantId: "org-1",
    },
    toolClass: "external_side_effect",
    capabilities: ["external.confirm"],
    authorityKind: "hosted_app_policy",
    authorityRevision: "authority-v2",
    requestedAt: "2026-08-03T12:00:00.000Z",
    expiresAt: "2026-08-03T12:05:00.000Z",
  } as const;
  assert.deepEqual(parseRunnerExternalApprovalBindingV2(bindingV2), bindingV2);
  assert.throws(
    () =>
      parseRunnerExternalApprovalBindingV2({
        ...bindingV2,
        actionKey: "other.tool",
      }),
    /actionKey must match stableToolIdentity\.toolId/u,
  );
  assert.throws(
    () =>
      parseRunnerExternalApprovalBindingV2({
        ...bindingV2,
        authorityRevision: "other-authority",
      }),
    /authorityRevision must match stableToolIdentity\.approvalAuthorityRevision/u,
  );
  assert.throws(
    () => parseRunnerExternalApprovalBindingV1(bindingV2),
    /unknown field 'preparedInvocationId'|version must/u,
  );
  assert.throws(
    () => parseRunnerExternalApprovalBindingV2({ ...bindingV2, runId: "renewable" }),
    /unknown field 'runId'/u,
  );
  assert.throws(
    () => parseStableToolApprovalIdentityV1({ ...toolIdentity, payloadHash: bindingV2.payloadHash }),
    /unknown field 'payloadHash'/u,
  );
  assert.equal(parseHostedToolApprovalDecision("remember_approval"), "remember_approval");
  assert.throws(() => parseHostedToolApprovalDecision("always"), /invalid/u);
  assert.deepEqual(parseRememberedToolApprovalEvidenceSetV1(undefined), []);
  assert.deepEqual(parseRememberedToolApprovalEvidenceSetV1([]), []);
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
