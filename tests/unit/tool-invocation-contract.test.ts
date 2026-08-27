import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolActivationRefV1,
  fingerprintToolScopeV1,
  hashCanonical,
} from "../../src/kestrel/contracts/tool-contract.js";
import {
  parseAgentToolResultV2,
  parseDurablePreparedToolCallV1,
  parsePreparedToolCallV1,
  parseRunToolUpdateV2,
  parseToolExecutionOutcomeV1,
} from "../../src/kestrel/contracts/tool-invocation.js";
import { defaultToolCatalog } from "../../tools/catalog.js";
import { createPreparedToolApprovalAuthorityV1 } from "../../src/io/ToolInvocationSupport.js";

const descriptor = defaultToolCatalog.getDescriptorRef("FinalizeAnswer");
if (descriptor === undefined) throw new Error("FinalizeAnswer descriptor missing");
const activation = createToolActivationRefV1({
  descriptor,
  registryGeneration: "generation-1",
  scopeFingerprint: fingerprintToolScopeV1({
    tenant: "tenant-a",
    environment: "environment-a",
    gateway: "local-core",
    authorizationScope: ["runtime"],
  }),
});
const timestamp = "2026-08-03T12:00:00.000Z";

function v2PreparedCallFixture(): Record<string, unknown> {
  const effectiveInput = { message: "done" };
  const policyRevision = hashCanonical({ policy: "ask" });
  const actor = {
    actorType: "end_user" as const,
    actorId: "user-1",
    tenantId: "org-1",
  };
  const stableToolIdentity = {
    version: "stable_tool_approval_identity_v1" as const,
    toolId: activation.descriptor.toolId,
    descriptorContractRevision: activation.descriptor.contractRevision,
    approvalAuthorityRevision: "approval-authority-v1",
  };
  const authorityPayload = {
    version: "prepared_tool_stable_authority_v1" as const,
    actor,
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    threadId: "thread-1",
    resourceAuthority: {
      gatewayUrl: "https://gateway.example.test/mcp",
      toolSourceKind: activation.descriptor.sourceKind,
      toolSourceId: activation.descriptor.sourceId,
    },
    policyRevision,
    capabilities: ["external.confirm", "network.call"],
    descriptorContractRevision: activation.descriptor.contractRevision,
    approvalAuthorityRevision: stableToolIdentity.approvalAuthorityRevision,
    normalizedActionHash: hashCanonical({
      toolId: activation.descriptor.toolId,
      effectiveInput,
    }),
  };
  const stableAuthority = {
    ...authorityPayload,
    fingerprint: hashCanonical(authorityPayload),
  };
  const externalApprovalBinding = {
    version: "runner_external_approval_binding_v2" as const,
    approvalId: "approval-1",
    preparedInvocationId: "call-1",
    threadId: authorityPayload.threadId,
    actionKey: activation.descriptor.toolId,
    payloadHash: hashCanonical(effectiveInput),
    stableAuthorityFingerprint: stableAuthority.fingerprint,
    stableToolIdentity,
    requestingActor: actor,
    toolClass: "external_side_effect" as const,
    capabilities: authorityPayload.capabilities,
    authorityKind: "hosted_app_policy" as const,
    authorityRevision: stableToolIdentity.approvalAuthorityRevision,
    requestedAt: timestamp,
    expiresAt: "2026-08-03T12:05:00.000Z",
  };
  return {
    version: "v1",
    runId: "run-1",
    sessionId: "session-1",
    callId: "call-1",
    activation,
    origin: {
      kind: "model",
      snapshotId: hashCanonical({ request: "model-1" }),
      modelToolCallId: "model-call-1",
    },
    effectiveInput,
    inputAdapters: [],
    policy: {
      decision: "approval_required",
      policyRevision,
    },
    approval: {
      authorityRevision: hashCanonical({ authority: "prepared-v1" }),
      approvalId: "approval-1",
      externalApprovalBinding,
    },
    stableAuthority,
    stableToolIdentity,
    executionRequirements: {
      version: "prepared_tool_execution_requirements_v1",
      credentials: ["continuation_run_segment", "live_handler_capability"],
    },
    preparedAt: timestamp,
  };
}

test("prepared calls accept only exact model or trusted-runtime origins", () => {
  const prepared = parsePreparedToolCallV1({
    version: "v1",
    runId: "run-1",
    sessionId: "session-1",
    callId: "call-1",
    activation,
    origin: {
      kind: "model",
      snapshotId: hashCanonical({ request: "model-1" }),
      modelToolCallId: "model-call-1",
    },
    effectiveInput: { message: "done" },
    policy: {
      decision: "allow",
      policyRevision: hashCanonical({ policy: "v1" }),
    },
    preparedAt: timestamp,
  });
  assert.equal(prepared.origin.kind, "model");
  assert.equal(Object.isFrozen(prepared), true);

  assert.throws(
    () =>
      parsePreparedToolCallV1({
        ...prepared,
        origin: { kind: "trusted_runtime", producerId: "recovery" },
      }),
    /adapterId/u,
  );
  assert.throws(
    () =>
      parsePreparedToolCallV1({
        ...prepared,
        origin: { kind: "replay", evidenceId: "old" },
      }),
    /origin (?:contains unknown field|kind is invalid)/u,
  );
});

test("prepared invocation identifiers must round-trip through durable JSON", () => {
  const fixture = {
    version: "v1",
    runId: "run-1",
    sessionId: "session-1",
    callId: `call-${"valid-😀".repeat(200)}`,
    activation,
    origin: {
      kind: "trusted_runtime",
      producerId: "runtime",
      adapterId: "direct",
    },
    effectiveInput: { message: "done" },
    policy: {
      decision: "allow",
      policyRevision: hashCanonical({ policy: "v1" }),
    },
    preparedAt: timestamp,
  };
  assert.equal(parsePreparedToolCallV1(fixture).callId, fixture.callId);
  for (const callId of ["call-high-\ud800", "call-low-\udc00", "call-null-\u0000"]) {
    assert.throws(
      () => parsePreparedToolCallV1({ ...fixture, callId }),
      /valid UTF-16|round-trip through durable JSON/u,
    );
  }
});

test("prepared approval authority rejects retired recovery adapters", () => {
  assert.throws(
    () => parsePreparedToolCallV1({
      version: "v1",
      runId: "run-1",
      sessionId: "session-1",
      callId: "call-1",
      activation,
      origin: {
        kind: "model",
        snapshotId: hashCanonical({ request: "model-1" }),
        modelToolCallId: "model-call-1",
      },
      effectiveInput: { message: "done" },
      policy: {
        decision: "approval_required",
        policyRevision: hashCanonical({ policy: "v1" }),
      },
      approval: {
        authorityRevision: hashCanonical({ authority: "v1" }),
        approvalId: "approval-1",
        recoveryAdapterId: "alternate-tool:v1",
      },
      preparedAt: timestamp,
    }),
    /approval contains unknown field 'recoveryAdapterId'/u,
  );
});

test("stable prepared approval authority excludes renewable execution credentials", () => {
  const context = (renewal: string, actorId = "user-1", threadId = "thread-1") => ({
    runId: `run-${renewal}`,
    sessionId: `session-${renewal}`,
    sessionState: {},
    payload: {
      actor: {
        actorType: "end_user",
        actorId,
        tenantId: "org-1",
      },
      hostedApprovalAuthority: {
        version: "runner_hosted_approval_authority_v1",
        organizationId: "org-1",
        environmentId: "env-1",
        projectId: "project-1",
        threadId,
      },
      mcpContext: {
        organizationId: "org-1",
        environmentId: "env-1",
        projectId: "project-1",
        threadId,
        gatewayUrl: "https://gateway.example.test/mcp",
        grantId: `grant-${renewal}`,
      },
      mcpAuthorization: { executionTicket: `ticket-${renewal}` },
      clientCapabilities: {
        kestrelOne: { contextGrantId: `context-${renewal}` },
      },
      workspace: {
        workspaceRoot: "/workspace/project",
        leaseId: `lease-${renewal}`,
      },
      orchestration: {
        devShellSourceWriteApprovalGrants: [
          { grantId: `source-${renewal}`, expiresAt: `2026-08-03T12:0${renewal}:00.000Z` },
        ],
      },
    },
  });
  const create = (
    runContext: ReturnType<typeof context>,
    effectiveInput: Record<string, unknown> = { message: "done" },
    overrides: {
      activation?: typeof activation;
      approvalAuthorityRevision?: string;
    } = {},
  ) => createPreparedToolApprovalAuthorityV1({
    activation: overrides.activation ?? activation,
    effectiveInput,
    policyRevision: hashCanonical({ policy: "ask" }),
    approvalAuthorityRevision:
      overrides.approvalAuthorityRevision ?? "approval-authority-v1",
    capabilities: ["external.confirm", "network.call"],
    runContext,
  });
  const first = create(context("1"));
  const rotated = create(context("2"));
  assert.ok(first);
  assert.ok(rotated);
  assert.equal(first.stableAuthority.fingerprint, rotated.stableAuthority.fingerprint);
  assert.deepEqual(first.stableToolIdentity, rotated.stableToolIdentity);
  assert.notEqual(
    first.stableAuthority.fingerprint,
    create(context("3"), { message: "changed" })?.stableAuthority.fingerprint,
  );
  assert.notEqual(
    first.stableAuthority.fingerprint,
    create(context("4", "user-2"))?.stableAuthority.fingerprint,
  );
  assert.notEqual(
    first.stableAuthority.fingerprint,
    create(context("5", "user-1", "thread-2"))?.stableAuthority.fingerprint,
  );
  assert.notEqual(
    first.stableAuthority.fingerprint,
    create(context("6"), { message: "done" }, {
      activation: {
        ...activation,
        descriptor: {
          ...activation.descriptor,
          contractRevision: hashCanonical({ descriptor: "v2" }),
        },
      },
    })?.stableAuthority.fingerprint,
  );
  assert.notEqual(
    first.stableAuthority.fingerprint,
    create(context("7"), { message: "done" }, {
      approvalAuthorityRevision: "approval-authority-v2",
    })?.stableAuthority.fingerprint,
  );
  assert.deepEqual(first.executionRequirements.credentials, [
    "continuation_run_segment",
    "live_handler_capability",
    "mcp_access_grant",
    "project_context_grant",
    "provider_execution_ticket",
    "source_write_grant",
    "workspace_lease",
  ]);
  assert.doesNotMatch(JSON.stringify(first.stableAuthority), /grant-1|lease-1|ticket-1|source-1/u);
});

test("V2 prepared approval authority round-trips as one consistent identity", () => {
  const fixture = v2PreparedCallFixture();
  const parsed = parsePreparedToolCallV1(fixture);
  assert.deepEqual(parsePreparedToolCallV1(parsed), parsed);
  assert.equal(
    parsed.approval?.externalApprovalBinding?.version,
    "runner_external_approval_binding_v2",
  );
});

test("durable V2 prepared approval authority requires its complete binding", () => {
  const transient = structuredClone(v2PreparedCallFixture()) as Record<
    string,
    any
  >;
  delete transient.approval.externalApprovalBinding;

  assert.doesNotThrow(() => parsePreparedToolCallV1(transient));
  assert.throws(
    () => parseDurablePreparedToolCallV1(transient),
    /requires a complete v2 external approval binding/u,
  );
  assert.doesNotThrow(() =>
    parseDurablePreparedToolCallV1(v2PreparedCallFixture()),
  );
});

test("V2 stable actor tenant must match its organization", () => {
  const fixture = structuredClone(v2PreparedCallFixture()) as Record<
    string,
    any
  >;
  fixture.stableAuthority.organizationId = "org-2";
  const { fingerprint: _fingerprint, ...authorityPayload } =
    fixture.stableAuthority;
  fixture.stableAuthority.fingerprint = hashCanonical(authorityPayload);
  fixture.approval.externalApprovalBinding.stableAuthorityFingerprint =
    fixture.stableAuthority.fingerprint;

  assert.throws(
    () => parsePreparedToolCallV1(fixture),
    /actor\.tenantId must match organizationId/u,
  );
});

test("V2 prepared approval authority rejects contradictory persisted identity", () => {
  const fixture = v2PreparedCallFixture();
  const mutate = (
    update: (copy: Record<string, any>) => void,
  ): Record<string, unknown> => {
    const copy = structuredClone(fixture) as Record<string, any>;
    update(copy);
    return copy;
  };
  const refingerprintAuthority = (copy: Record<string, any>): void => {
    const { fingerprint: _fingerprint, ...authorityPayload } =
      copy.stableAuthority;
    copy.stableAuthority.fingerprint = hashCanonical(authorityPayload);
    copy.approval.externalApprovalBinding.stableAuthorityFingerprint =
      copy.stableAuthority.fingerprint;
  };
  const contradictions: Array<[string, (copy: Record<string, any>) => void]> = [
    ["actor", (copy) => { copy.approval.externalApprovalBinding.requestingActor.actorId = "user-2"; }],
    ["thread", (copy) => { copy.approval.externalApprovalBinding.threadId = "thread-2"; }],
    ["tool", (copy) => {
      copy.stableToolIdentity.toolId = "other.tool";
      copy.approval.externalApprovalBinding.actionKey = "other.tool";
      copy.approval.externalApprovalBinding.stableToolIdentity.toolId = "other.tool";
    }],
    ["descriptor", (copy) => {
      const revision = hashCanonical({ descriptor: "other" });
      copy.stableToolIdentity.descriptorContractRevision = revision;
      copy.approval.externalApprovalBinding.stableToolIdentity.descriptorContractRevision = revision;
    }],
    ["stable authority descriptor", (copy) => {
      copy.stableAuthority.descriptorContractRevision = hashCanonical({ descriptor: "forged" });
      refingerprintAuthority(copy);
    }],
    ["capability", (copy) => { copy.approval.externalApprovalBinding.capabilities = ["external.confirm"]; }],
    ["authority revision", (copy) => {
      copy.stableAuthority.approvalAuthorityRevision = "approval-authority-v2";
      refingerprintAuthority(copy);
    }],
    ["normalized action", (copy) => {
      copy.stableAuthority.normalizedActionHash = hashCanonical({ changed: true });
      refingerprintAuthority(copy);
    }],
    ["authority fingerprint", (copy) => {
      copy.stableAuthority.fingerprint = hashCanonical({ forged: true });
      copy.approval.externalApprovalBinding.stableAuthorityFingerprint = copy.stableAuthority.fingerprint;
    }],
    ["payload", (copy) => { copy.effectiveInput.message = "changed after approval"; }],
    ["prepared invocation", (copy) => { copy.approval.externalApprovalBinding.preparedInvocationId = "call-2"; }],
    ["approval", (copy) => { copy.approval.approvalId = "approval-2"; }],
    ["policy revision", (copy) => { copy.policy.policyRevision = hashCanonical({ policy: "other" }); }],
    ["tool source", (copy) => {
      copy.stableAuthority.resourceAuthority.toolSourceId = "other-source";
      refingerprintAuthority(copy);
    }],
  ];
  for (const [label, update] of contradictions) {
    assert.throws(
      () => parsePreparedToolCallV1(mutate(update)),
      /fingerprint does not match|normalized action does not match|identities do not agree/u,
      label,
    );
  }
});

test("tool outcomes require normalized terminal evidence and forbid retry after commit", () => {
  const failure = parseToolExecutionOutcomeV1({
    version: "v1",
    callId: "call-1",
    activation,
    kind: "failure",
    startedAt: timestamp,
    completedAt: timestamp,
    effectState: "not_started",
    normalizedFailureCode: "TOOL_RESULT_CONTRACT_FAILED",
    retryable: false,
    error: { message: "output rejected" },
  });
  assert.equal(failure.kind, "failure");
  assert.throws(
    () =>
      parseToolExecutionOutcomeV1({
        ...failure,
        effectState: "committed",
        retryable: true,
      }),
    /committed external effect cannot be retryable/u,
  );
  assert.throws(
    () =>
      parseToolExecutionOutcomeV1({
        ...failure,
        kind: "cancellation",
        normalizedFailureCode: "SOMETHING_ELSE",
      }),
    /must be TOOL_CANCELLED and terminal/u,
  );
});

test("V2 result and run updates require one agreeing activation identity", () => {
  const outcome = parseToolExecutionOutcomeV1({
    version: "v1",
    callId: "call-1",
    activation,
    kind: "success",
    startedAt: timestamp,
    completedAt: timestamp,
    effectState: "not_applicable",
    rawOutput: { accepted: true },
  });
  const result = parseAgentToolResultV2({
    version: "v2",
    toolName: "FinalizeAnswer",
    status: "OK",
    toolCallId: "call-1",
    activation,
    outcome,
    modelContext: {
      text: "accepted",
      rawOutputRef: "sha256:artifact",
      truncated: false,
    },
    auditRecord: {
      toolName: "FinalizeAnswer",
      input: { message: "done" },
      output: { accepted: true },
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      status: "OK",
    },
  });
  assert.equal(result.activation.descriptor.contractRevision, descriptor.contractRevision);

  const update = parseRunToolUpdateV2({
    version: "v2",
    runId: "run-1",
    sessionId: "session-1",
    ts: timestamp,
    seq: 1,
    toolCallId: "call-1",
    toolName: "FinalizeAnswer",
    activation,
    phase: "completed",
    outcome,
    output: { accepted: true },
  });
  assert.equal(update.outcome?.kind, "success");

  assert.throws(
    () => parseAgentToolResultV2({ ...result, toolCallId: "call-other" }),
    /evidence identities do not agree/u,
  );
  assert.throws(
    () =>
      parseRunToolUpdateV2({
        ...update,
        activation: {
          ...activation,
          descriptor: { ...descriptor, toolId: "other" },
        },
      }),
    /activation does not match toolName/u,
  );
});
