import assert from "node:assert/strict";
import test from "node:test";

import type { RunnerExternalApprovalBindingV1 } from "@kestrel-agents/protocol";
import {
  CodeExecutionService,
  digestSandboxCapabilityExternalPayload,
  sandboxCapabilityExternalActionKey,
} from "../../src/code/CodeExecutionService.js";
import { SandboxCapabilityAdapterRegistry, type SandboxCapabilityAdapter } from "../../src/code/SandboxCapabilityAdapterRegistry.js";
import { SandboxCapabilityLeaseCoordinator } from "../../src/code/SandboxCapabilityLeaseCoordinator.js";
import { DEFAULT_CODE_MODE_ENABLED_CONFIG, type SandboxCapabilityRuntimeContext } from "../../src/code/contracts.js";
import {
  fingerprintSandboxCapabilityCatalogV2,
  fingerprintSandboxCapabilityProfileV2,
  type SandboxCapabilityLeaseBinding,
  type SandboxCapabilityProfileV2,
} from "../../src/kestrel/contracts/sandbox-capability.js";
import { KESTREL_EXECUTION_BOUNDARY_POLICY } from "../../src/security/ExecutionBoundaryPolicy.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";

const capabilityId = "test.message.send";
const operation = "send";
const canonicalInput = { recipient: "recipient-a", message: "hello" };
const profile: SandboxCapabilityProfileV2 = {
  version: 2,
  capabilityId,
  operation,
  resource: "https://messages.example.test/send",
  effectClass: "external_effect",
  audience: { tenantId: "tenant-a", environmentId: "env-a" },
  maxRequests: 1,
  maxResponseBytes: 1024,
  timeoutMs: 1000,
  maxExpiryMs: 5000,
  brokerAuthority: { authorityId: "broker-a", revision: "broker-r1" },
  adapterConfig: {},
};

const externalAdapter: SandboxCapabilityAdapter<SandboxCapabilityProfileV2, { input: typeof canonicalInput }, typeof canonicalInput, { accepted: true }> = {
  capabilityId,
  operation,
  resource: profile.resource,
  credentialId: "tool.test-message.default",
  effectClass: "external_effect",
  modelContract: {
    description: "Send one fixed-resource test message.",
    usage: "Select only for the exact approved test action; omission is allowed.",
    optional: true,
    selectionInputSchema: { type: "object", additionalProperties: false },
    examples: [{ recipient: "test", message: "hello" }],
  },
  parseProfile: (value) => value as SandboxCapabilityProfileV2,
  parseSelection: (value) => value as { input: typeof canonicalInput },
  canonicalInput: (_profile, selection) => structuredClone(selection.input),
  destination: () => "messages.example.test",
  invoke: async () => ({ accepted: true }),
};

test("external-effect sandbox adapters accept only the exact prepared action and effect authority", async () => {
  const exact = exactApprovalBinding();
  const rejected: Array<[string, (runtime: SandboxCapabilityRuntimeContext) => void]> = [
    ["read or source authority", (runtime) => { runtime.policy = { decision: "allow", policyRevision: "policy-r1" }; runtime.approval = undefined; }],
    ["approval without an action binding", (runtime) => { runtime.approval = { approvalId: "approval-a", authorityRevision: "authority-r1" }; }],
    ["prior expired approval", (runtime) => { runtime.approval!.externalApprovalBinding = { ...exact, expiresAt: "2026-08-22T11:59:59.000Z" }; }],
    ["another approval", (runtime) => { runtime.approval!.approvalId = "approval-other"; }],
    ["another tool call or action key", (runtime) => { runtime.approval!.externalApprovalBinding = { ...exact, actionKey: sandboxCapabilityExternalActionKey({ toolCallId: "call-other", capabilityId, operation }) }; }],
    ["another canonical payload", (runtime) => { runtime.approval!.externalApprovalBinding = { ...exact, payloadHash: digestSandboxCapabilityExternalPayload({ capabilityId, operation, input: { ...canonicalInput, message: "different" } }) }; }],
    ["another run", (runtime) => { runtime.approval!.externalApprovalBinding = { ...exact, runId: "run-other" }; }],
    ["another thread", (runtime) => { runtime.approval!.externalApprovalBinding = { ...exact, threadId: "thread-other" }; }],
    ["an unrelated effect capability", (runtime) => { runtime.approval!.externalApprovalBinding = { ...exact, capabilities: ["code.execute", "test.other"] }; }],
  ];

  for (const [label, mutate] of rejected) {
    let credentialResolutions = 0;
    const runtime = createRuntime(exact, () => { credentialResolutions += 1; });
    mutate(runtime);
    await assert.rejects(execute(runtime), /exact current action-bound approval/u, label);
    assert.equal(credentialResolutions, 0, `${label} reached credential resolution`);
  }

  let issuedBinding: SandboxCapabilityLeaseBinding | undefined;
  const runtime = createRuntime(exact);
  const request = runtime.leaseCoordinator!.request.bind(runtime.leaseCoordinator);
  runtime.leaseCoordinator!.request = async (input) => {
    issuedBinding = structuredClone(input.binding);
    return request(input);
  };
  const result = await execute(runtime);
  assert.equal(result.status, "ok");
  assert.equal(issuedBinding?.version, 2);
  assert.deepEqual(issuedBinding?.version === 2 ? issuedBinding.externalApprovalBinding : undefined, exact);
  assert.equal(issuedBinding?.toolCallId, "call-a");
});

function exactApprovalBinding(): RunnerExternalApprovalBindingV1 {
  return {
    version: "runner_external_approval_binding_v1",
    approvalId: "approval-a",
    threadId: "thread-a",
    runId: "run-a",
    actionKey: sandboxCapabilityExternalActionKey({ toolCallId: "call-a", capabilityId, operation }),
    payloadHash: digestSandboxCapabilityExternalPayload({ capabilityId, operation, input: canonicalInput }),
    toolClass: "external_side_effect",
    capabilities: ["code.execute", capabilityId].sort(),
    authorityKind: "runtime_policy",
    authorityRevision: "authority-r1",
    requestedAt: "2026-08-22T11:59:00.000Z",
    expiresAt: "2026-08-22T12:01:00.000Z",
  };
}

function createRuntime(binding: RunnerExternalApprovalBindingV1, onCredential = () => {}): SandboxCapabilityRuntimeContext {
  const store = new InMemorySessionStore();
  return {
    tenantId: "tenant-a",
    environmentId: "env-a",
    sessionId: "session-a",
    runId: "run-a",
    threadId: "thread-a",
    toolCallId: "call-a",
    policy: { decision: "approval_required", policyRevision: "policy-r1" },
    approval: { approvalId: "approval-a", authorityRevision: "authority-r1", externalApprovalBinding: structuredClone(binding) },
    profileFingerprint: fingerprintSandboxCapabilityProfileV2(profile),
    capabilityCatalogFingerprint: fingerprintSandboxCapabilityCatalogV2([profile]),
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    brokerAuthority: profile.brokerAuthority,
    resolveCredentialSnapshot: async () => { onCredential(); return { credentialId: externalAdapter.credentialId, revision: "credential-r1", secret: "secret" }; },
    registerSensitiveValue: () => () => {},
    redactSensitiveValues: <T>(value: T) => value,
    now: () => new Date("2026-08-22T12:00:00.000Z"),
    leaseCoordinator: new SandboxCapabilityLeaseCoordinator({
      store,
      now: () => new Date("2026-08-22T12:00:00.000Z"),
      validateCurrent: async () => ({ authorized: true }),
      persistResult: async ({ leaseId }) => ({ digest: "a".repeat(64), reference: `test:${leaseId}` }),
    }),
  };
}

async function execute(runtime: SandboxCapabilityRuntimeContext) {
  const service = new CodeExecutionService({
    capabilityAdapters: new SandboxCapabilityAdapterRegistry([externalAdapter]),
    executor: { async execute() { return { status: "ok", exitCode: 0, stdout: "accepted", stderr: "", durationMs: 1, artifacts: [] }; } },
  });
  return service.execute(
    { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] },
    { language: "javascript", code: "console.log('test')", capability: { version: 2, capabilityId, operation, input: canonicalInput } },
    { capabilityRuntime: runtime },
  );
}
