import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerExternalApprovalBindingV1 } from "@kestrel-agents/protocol";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  applyRequiredManagedWorkspacePolicy,
  createModelGatewayForProfile,
  createRuntimeFactoryWithStore,
  resolveManagedWorktreesEnabledForRuntime,
  resolveSandboxCapabilityAudienceFromEnvironment,
  resolveSandboxCapabilityBrokerAuthorityFromEnvironment,
  resolveSandboxCapabilityRuntimeEnvironment,
  persistSandboxCapabilityResultEvidence,
  validateSandboxCapabilityLeaseCurrent,
} from "../../cli/runtime/KestrelChatRuntime.js";
import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import {
  fingerprintSandboxCapabilityCatalogV1,
  fingerprintSandboxCapabilityLeaseBindingV1,
  type SandboxCapabilityLeaseBindingV1,
} from "../../src/kestrel/contracts/sandbox-capability.js";
import type { SessionStore } from "../../src/kestrel/contracts/store.js";
import {
  createToolActivationRefV1,
  fingerprintToolScopeV1,
  hashCanonical,
} from "../../src/kestrel/contracts/tool-contract.js";
import {
  KESTREL_EXECUTION_BOUNDARY_POLICY,
  SensitiveValueRegistry,
} from "../../src/security/ExecutionBoundaryPolicy.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import { defaultToolCatalog } from "../../tools/catalog.js";

test("sandbox capability result artifacts recursively redact registered secrets before digest and persistence", async () => {
  const store = new InMemorySessionStore();
  const registry = new SensitiveValueRegistry();
  const secret = "nested-provider-secret";
  const release = registry.register({
    reference: { referenceId: "credential-r1", kind: "credential", scope: "sandbox-capability" },
    value: secret,
  });
  const digest = "a".repeat(64);
  const binding: SandboxCapabilityLeaseBindingV1 = {
    version: 1,
    tenantId: "tenant-a",
    environmentId: "environment-a",
    sessionId: "session-a",
    runId: "run-a",
    toolCallId: "call-a",
    profileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    capabilityId: "tavily.search.read",
    operation: "search",
    resource: "https://api.tavily.com/search",
    audience: { tenantId: "tenant-a", environmentId: "environment-a" },
    brokerAuthority: { authorityId: "broker-a", revision: "revision-a" },
    credentialReference: { credentialId: "tool.tavily.default", revision: "credential-r1" },
    policyRevision: "policy-r1",
  };

  const evidence = await persistSandboxCapabilityResultEvidence({
    store,
    leaseId: "lease-a",
    binding,
    result: { results: [{ content: `prefix ${secret} suffix`, nested: { token: secret } }] },
    redact: <T>(value: T) => registry.redact(value).value,
  });
  release();

  const artifact = await store.getArtifact({ artifactId: "sandbox-capability-result:lease-a", sessionId: "session-a" });
  const serialized = JSON.stringify({ artifact, evidence });
  assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /redacted/iu);
  assert.equal((artifact?.payload as { bindingDigest?: string }).bindingDigest, fingerprintSandboxCapabilityLeaseBindingV1(binding));
});

test("sandbox capability currentness rejects independent policy replacement and preserves exact DONE replay", async () => {
  const descriptor = defaultToolCatalog.getDescriptorRef("code.execute");
  if (descriptor === undefined) throw new Error("code.execute descriptor missing");
  const activation = createToolActivationRefV1({
    descriptor,
    registryGeneration: "generation-currentness",
    scopeFingerprint: fingerprintToolScopeV1({ tenant: "tenant-a", environment: "environment-a", gateway: "local-core", authorizationScope: ["runtime"] }),
  });
  const currentPolicyRevision = hashCanonical({ policy: "current" });
  const stalePolicyRevision = hashCanonical({ policy: "stale" });
  const effectiveInput = { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "exact" } } };
  let policyDecision: "allow" | "approval_required" = "allow";
  let preparedApproval: { approvalId: string; authorityRevision: string; externalApprovalBinding?: RunnerExternalApprovalBindingV1 } | undefined;
  let approvalGrants: Array<{ grantId: string; status: string; expiresAt: string; authorityRevision: string }> = [];
  let effectStatus: "PENDING" | "DONE" = "PENDING";
  const digest = "a".repeat(64);
  const legacyCatalogDigest = "7eab21dde0392113932278c803b9fbf9beb0d21f869af2eb847aa94887222441";
  assert.equal(fingerprintSandboxCapabilityCatalogV1([{
    version: 1,
    capabilityId: "tavily.search.read",
    operations: ["search"],
    resource: "https://api.tavily.com/search",
    audience: { tenantId: "tenant-a", environmentId: "environment-a" },
    maxRequests: 1,
    maxQueryChars: 100,
    maxResults: 3,
    maxResponseBytes: 4096,
    timeoutMs: 1000,
    maxExpiryMs: 5000,
    brokerAuthority: { authorityId: "broker-a", revision: "broker-r1" },
  }]), legacyCatalogDigest);
  const binding: SandboxCapabilityLeaseBindingV1 = {
    version: 1,
    tenantId: "tenant-a",
    environmentId: "environment-a",
    sessionId: "session-policy",
    runId: "run-policy",
    toolCallId: "call-policy",
    profileFingerprint: digest,
    capabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    capabilityId: "tavily.search.read",
    operation: "search",
    resource: "https://api.tavily.com/search",
    audience: { tenantId: "tenant-a", environmentId: "environment-a" },
    brokerAuthority: { authorityId: "broker-a", revision: "broker-r1" },
    credentialReference: { credentialId: "tool.tavily.default", revision: "credential-r1" },
    policyRevision: stalePolicyRevision,
  };
  const persistedEffect = () => ({
        runId: binding.runId,
        sessionId: binding.sessionId,
        stepIndex: 0,
        type: "execute_tool_call",
        payload: { preparedToolCall: {
          version: "v1",
          runId: binding.runId,
          sessionId: binding.sessionId,
          callId: binding.toolCallId,
          activation,
          origin: { kind: "model", snapshotId: hashCanonical({ snapshot: 1 }), modelToolCallId: "model-call-policy" },
          effectiveInput,
          inputAdapters: [],
          policy: { decision: policyDecision, policyRevision: currentPolicyRevision },
          ...(preparedApproval === undefined ? {} : { approval: preparedApproval }),
          preparedAt: "2026-08-23T12:00:00.000Z",
        } },
        idempotencyKey: binding.toolCallId,
        failurePolicy: "STOP",
        status: effectStatus,
        createdAt: "2026-08-23T12:00:00.000Z",
      });
  const store = {
    async listPendingEffects() { return effectStatus === "PENDING" ? [persistedEffect()] : []; },
    async getPersistedEffect() { return persistedEffect(); },
    async getEffectResult() {
      return effectStatus === "DONE"
        ? { idempotencyKey: binding.toolCallId, status: "DONE", output: { recorded: true }, timestamp: "2026-08-23T12:00:01.000Z" }
        : null;
    },
    async listApprovalGrants() { return approvalGrants; },
  } as unknown as SessionStore;

  const result = await validateSandboxCapabilityLeaseCurrent({
    binding,
    boundary: "issuance",
    profileFingerprint: digest,
    legacyProfileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    legacyCapabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    audience: binding.audience,
    brokerAuthority: binding.brokerAuthority,
    credentialResolver: async () => ({ credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" }),
    resolveCurrentPolicy: async () => ({ decision: policyDecision, policyRevision: currentPolicyRevision }),
    store,
  });
  assert.deepEqual(result, { authorized: false, reason: "prepared_policy_changed_or_denied" });

  const hostPolicyReplacement = await validateSandboxCapabilityLeaseCurrent({
    binding: { ...binding, policyRevision: currentPolicyRevision },
    boundary: "provider_invocation",
    profileFingerprint: digest,
    legacyProfileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    legacyCapabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    audience: binding.audience,
    brokerAuthority: binding.brokerAuthority,
    credentialResolver: async () => ({ credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" }),
    resolveCurrentPolicy: async () => ({ decision: "allow", policyRevision: hashCanonical({ policy: "host-replacement" }) }),
    store,
  });
  assert.deepEqual(hostPolicyReplacement, { authorized: false, reason: "prepared_policy_changed_or_denied" });

  const upstreamAuthorityRevision = hashCanonical({ approval: "upstream" });
  preparedApproval = {
    approvalId: "grant-policy",
    authorityRevision: hashCanonical({
      version: "prepared-tool-approval-authority-v1",
      activation,
      effectiveInput,
      inputAdapters: [],
      policyRevision: currentPolicyRevision,
      upstreamAuthorityRevision,
    }),
  };
  policyDecision = "approval_required";
  approvalGrants = [{
    grantId: "grant-policy",
    status: "ACTIVE",
    expiresAt: "2026-08-23T11:59:59.000Z",
    authorityRevision: upstreamAuthorityRevision,
  }];
  const expired = await validateSandboxCapabilityLeaseCurrent({
    binding: { ...binding, policyRevision: currentPolicyRevision, approval: preparedApproval },
    boundary: "provider_invocation",
    profileFingerprint: digest,
    legacyProfileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    legacyCapabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    audience: binding.audience,
    brokerAuthority: binding.brokerAuthority,
    credentialResolver: async () => ({ credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" }),
    resolveCurrentPolicy: async () => ({ decision: policyDecision, policyRevision: currentPolicyRevision }),
    store,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  assert.deepEqual(expired, { authorized: false, reason: "approval_revoked_or_stale" });

  approvalGrants[0]!.expiresAt = "2026-08-23T12:01:00.000Z";
  const active = await validateSandboxCapabilityLeaseCurrent({
    binding: { ...binding, policyRevision: currentPolicyRevision, approval: preparedApproval },
    boundary: "result_delivery",
    profileFingerprint: digest,
    legacyProfileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    legacyCapabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    audience: binding.audience,
    brokerAuthority: binding.brokerAuthority,
    credentialResolver: async () => ({ credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" }),
    resolveCurrentPolicy: async () => ({ decision: policyDecision, policyRevision: currentPolicyRevision }),
    store,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  assert.deepEqual(active, { authorized: true });

  const v1WithV2Fingerprint = await validateSandboxCapabilityLeaseCurrent({
    binding: { ...binding, capabilityCatalogFingerprint: digest, policyRevision: currentPolicyRevision, approval: preparedApproval },
    boundary: "result_delivery",
    profileFingerprint: digest,
    legacyProfileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    legacyCapabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    audience: binding.audience,
    brokerAuthority: binding.brokerAuthority,
    credentialResolver: async () => ({ credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" }),
    resolveCurrentPolicy: async () => ({ decision: policyDecision, policyRevision: currentPolicyRevision }),
    store,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  assert.deepEqual(v1WithV2Fingerprint, { authorized: false, reason: "capability_catalog_changed" });

  const externalApprovalBinding: RunnerExternalApprovalBindingV1 = {
    version: "runner_external_approval_binding_v1",
    approvalId: "grant-policy",
    threadId: "thread-policy",
    runId: binding.runId,
    actionKey: `code.execute:${binding.toolCallId}:${binding.capabilityId}:${binding.operation}`,
    payloadHash: `sha256:${"c".repeat(64)}`,
    toolClass: "external_side_effect",
    capabilities: ["code.execute", binding.capabilityId],
    authorityKind: "runtime_policy",
    authorityRevision: upstreamAuthorityRevision,
    requestedAt: "2026-08-23T11:59:00.000Z",
    expiresAt: "2026-08-23T12:01:00.000Z",
  };
  preparedApproval.externalApprovalBinding = externalApprovalBinding;
  const externalBinding = {
    ...binding,
    version: 2 as const,
    capabilityCatalogFingerprint: digest,
    effectClass: "external_effect" as const,
    policyRevision: currentPolicyRevision,
    approval: { approvalId: preparedApproval.approvalId, authorityRevision: preparedApproval.authorityRevision },
    externalApprovalBinding,
  };
  const exactExternal = await validateSandboxCapabilityLeaseCurrent({
    binding: externalBinding,
    boundary: "provider_invocation",
    profileFingerprint: digest,
    legacyProfileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    legacyCapabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    audience: binding.audience,
    brokerAuthority: binding.brokerAuthority,
    credentialResolver: async () => ({ credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" }),
    resolveCurrentPolicy: async () => ({ decision: policyDecision, policyRevision: currentPolicyRevision }),
    store,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  assert.deepEqual(exactExternal, { authorized: true });
  const v2WithV1Fingerprint = await validateSandboxCapabilityLeaseCurrent({
    binding: { ...externalBinding, capabilityCatalogFingerprint: legacyCatalogDigest },
    boundary: "provider_invocation",
    profileFingerprint: digest,
    legacyProfileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    legacyCapabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    audience: binding.audience,
    brokerAuthority: binding.brokerAuthority,
    credentialResolver: async () => ({ credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" }),
    resolveCurrentPolicy: async () => ({ decision: policyDecision, policyRevision: currentPolicyRevision }),
    store,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  assert.deepEqual(v2WithV1Fingerprint, { authorized: false, reason: "capability_catalog_changed" });
  const changedExternal = await validateSandboxCapabilityLeaseCurrent({
    binding: { ...externalBinding, externalApprovalBinding: { ...externalApprovalBinding, actionKey: "code.execute:another-call:tavily.search.read:search" } },
    boundary: "provider_invocation",
    profileFingerprint: digest,
    legacyProfileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    legacyCapabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    audience: binding.audience,
    brokerAuthority: binding.brokerAuthority,
    credentialResolver: async () => ({ credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" }),
    resolveCurrentPolicy: async () => ({ decision: policyDecision, policyRevision: currentPolicyRevision }),
    store,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  assert.deepEqual(changedExternal, { authorized: false, reason: "external_effect_action_approval_changed" });

  effectStatus = "DONE";
  const completedReplay = await validateSandboxCapabilityLeaseCurrent({
    binding: { ...binding, policyRevision: currentPolicyRevision, approval: preparedApproval },
    boundary: "recorded_replay",
    profileFingerprint: digest,
    legacyProfileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    legacyCapabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    audience: binding.audience,
    brokerAuthority: binding.brokerAuthority,
    credentialResolver: async () => { throw new Error("recorded replay must not resolve a live credential"); },
    resolveCurrentPolicy: async () => ({ decision: policyDecision, policyRevision: currentPolicyRevision }),
    store,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  assert.deepEqual(completedReplay, { authorized: true });

  const forbiddenResume = await validateSandboxCapabilityLeaseCurrent({
    binding: { ...binding, policyRevision: currentPolicyRevision, approval: preparedApproval },
    boundary: "recovery_resume",
    profileFingerprint: digest,
    legacyProfileFingerprint: digest,
    capabilityCatalogFingerprint: digest,
    legacyCapabilityCatalogFingerprint: legacyCatalogDigest,
    executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    audience: binding.audience,
    brokerAuthority: binding.brokerAuthority,
    credentialResolver: async () => ({ credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" }),
    resolveCurrentPolicy: async () => ({ decision: policyDecision, policyRevision: currentPolicyRevision }),
    store,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  assert.deepEqual(forbiddenResume, { authorized: false, reason: "prepared_call_authority_missing_or_ambiguous" });
});


const BASE_PROFILE: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

const CAPABILITY_PROFILE: TuiProfile = {
  ...BASE_PROFILE,
  codeMode: {
    enabled: true,
    languages: ["javascript"],
    sandbox: {
      executor: "docker",
      timeoutMs: 1_000,
      memoryMb: 128,
      cpuShares: 256,
      pidsLimit: 64,
      maxOutputBytes: 16_000,
      maxArtifacts: 8,
      maxArtifactBytes: 1_000_000,
      workspaceSizeMb: 64,
      workspaceInodes: 4_096,
      tmpSizeMb: 32,
      tmpInodes: 2_048,
      networkDefault: "off",
      allowDependencyInstall: false,
    },
    retention: { persistSummary: true, persistArtifacts: true },
    approvalMode: "auto",
    capabilities: [{
      version: 1,
      capabilityId: "tavily.search.read",
      operations: ["search"],
      resource: "https://api.tavily.com/search",
      audience: { tenantId: "tenant-a", environmentId: "environment-a" },
      maxRequests: 1,
      maxQueryChars: 100,
      maxResults: 3,
      maxResponseBytes: 4_096,
      timeoutMs: 1_000,
      maxExpiryMs: 5_000,
      brokerAuthority: { authorityId: "broker-a", revision: "revision-a" },
    }],
  },
};

function resolveCapabilityRuntime(
  profile: TuiProfile,
  trustedAudience: { tenantId: string; environmentId: string } | undefined,
  trustedBrokerAuthority: { authorityId: string; revision: string } | undefined,
) {
  let credentialResolutions = 0;
  const resolved = resolveSandboxCapabilityRuntimeEnvironment(
    profile,
    trustedAudience,
    trustedBrokerAuthority,
    "a".repeat(64),
    "b".repeat(64),
    async () => {
      credentialResolutions += 1;
      return { credentialId: "tool.tavily.default", revision: "credential-a", secret: "secret-a" };
    },
    () => () => {},
    (value) => value,
  );
  return { resolved, credentialResolutions };
}

test("sandbox capability runtime binds the authored audience to independent runtime identity", () => {
  const { resolved } = resolveCapabilityRuntime(CAPABILITY_PROFILE, {
    tenantId: "tenant-a",
    environmentId: "environment-a",
  }, { authorityId: "broker-a", revision: "revision-a" });
  assert.ok(resolved?.sandboxCapabilityRuntime);
  assert.deepEqual(
    {
      tenantId: resolved?.sandboxCapabilityRuntime.tenantId,
      environmentId: resolved?.sandboxCapabilityRuntime.environmentId,
      boundaryRevision: resolved?.sandboxCapabilityRuntime.executionBoundaryRevision,
    },
    {
      tenantId: "tenant-a",
      environmentId: "environment-a",
      boundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    },
  );
});

test("sandbox capability runtime rejects forged tenant and environment audiences before credential resolution", () => {
  for (const trustedAudience of [
    { tenantId: "tenant-b", environmentId: "environment-a" },
    { tenantId: "tenant-a", environmentId: "environment-b" },
  ]) {
    let credentialResolutions = 0;
    assert.throws(
      () => resolveSandboxCapabilityRuntimeEnvironment(
        CAPABILITY_PROFILE,
        trustedAudience,
        { authorityId: "broker-a", revision: "revision-a" },
        "a".repeat(64),
        "b".repeat(64),
        async () => {
          credentialResolutions += 1;
          return { credentialId: "tool.tavily.default", revision: "credential-a", secret: "secret-a" };
        },
        () => () => {},
        (value) => value,
      ),
      /audience does not match/u,
    );
    assert.equal(credentialResolutions, 0);
  }
});

test("sandbox capability runtime fails closed without an independent runtime identity", () => {
  assert.throws(
    () => resolveCapabilityRuntime(
      CAPABILITY_PROFILE,
      undefined,
      { authorityId: "broker-a", revision: "revision-a" },
    ),
    /trusted tenant and environment identity is unavailable/u,
  );
});

test("sandbox capability runtime rejects forged broker authority before credential resolution", () => {
  for (const trustedBrokerAuthority of [
    { authorityId: "broker-b", revision: "revision-a" },
    { authorityId: "broker-a", revision: "revision-b" },
  ]) {
    const result = () => resolveCapabilityRuntime(
      CAPABILITY_PROFILE,
      { tenantId: "tenant-a", environmentId: "environment-a" },
      trustedBrokerAuthority,
    );
    assert.throws(result, /broker authority does not match/u);
  }
});

test("sandbox capability runtime fails closed without independent broker authority", () => {
  assert.throws(
    () => resolveCapabilityRuntime(
      CAPABILITY_PROFILE,
      { tenantId: "tenant-a", environmentId: "environment-a" },
      undefined,
    ),
    /trusted broker authority is unavailable/u,
  );
});

test("local capability authority is assembled only from host runtime variables", () => {
  const env = {
    KESTREL_TENANT_ID: "tenant-a",
    KESTREL_ENVIRONMENT_ID: "environment-a",
    KESTREL_SANDBOX_BROKER_AUTHORITY_ID: "broker-a",
    KESTREL_SANDBOX_BROKER_AUTHORITY_REVISION: "revision-a",
  };
  assert.deepEqual(resolveSandboxCapabilityAudienceFromEnvironment(env), CAPABILITY_PROFILE.codeMode?.capabilities?.[0]?.audience);
  assert.deepEqual(resolveSandboxCapabilityBrokerAuthorityFromEnvironment(env), CAPABILITY_PROFILE.codeMode?.capabilities?.[0]?.brokerAuthority);
  assert.equal(resolveSandboxCapabilityAudienceFromEnvironment({ KESTREL_TENANT_ID: "tenant-a" }), undefined);
  assert.equal(resolveSandboxCapabilityBrokerAuthorityFromEnvironment({ KESTREL_SANDBOX_BROKER_AUTHORITY_ID: "broker-a" }), undefined);
});

test("gateway profile credential identity cannot replace host-resolved capability authority", () => {
  let credentialResolutions = 0;
  const gatewayProfile: TuiProfile = {
    ...CAPABILITY_PROFILE,
    modelCredential: {
      source: "kestrel-one",
      runId: "run-a",
      gatewayId: "gateway-a",
      organizationId: "tenant-a",
      environmentId: "environment-a",
      rawModelId: "openai/gpt-5.4",
      provider: "openai",
    },
  };
  assert.throws(
    () => resolveSandboxCapabilityRuntimeEnvironment(
      gatewayProfile,
      { tenantId: "tenant-a", environmentId: "host-environment" },
      { authorityId: "broker-a", revision: "revision-a" },
      "a".repeat(64),
      "b".repeat(64),
      async () => {
        credentialResolutions += 1;
        return { credentialId: "tool.tavily.default", revision: "credential-a", secret: "secret-a" };
      },
      () => () => {},
      (value) => value,
    ),
    /audience does not match/u,
  );
  assert.equal(credentialResolutions, 0);
});

test("resolveManagedWorktreesEnabledForRuntime defaults off and honors explicit opt-in", () => {
  assert.equal(resolveManagedWorktreesEnabledForRuntime({}), false);
  assert.equal(resolveManagedWorktreesEnabledForRuntime({ KESTREL_ENABLE_MANAGED_WORKTREES: "true" }), true);
  assert.equal(resolveManagedWorktreesEnabledForRuntime({ KESTREL_ENABLE_MANAGED_WORKTREES: "false" }), false);
});

test("runtime factory preserves managed-worktree host capability paths", async () => {
  const store = new InMemorySessionStore();
  const emptyEnvironment = {
    runtimeEnv: {},
    modelEnv: {},
    internetEnv: {},
    mcpEnv: {},
  };
  const createBootstrap = (
    profile: TuiProfile,
    options: Parameters<typeof createRuntimeFactoryWithStore>[1] = {},
  ) =>
    createRuntimeFactoryWithStore(store, {
      resolveEnvironment: () => emptyEnvironment,
      ...options,
    }).create(profile, (payload) => payload);

  const defaultBootstrap = createBootstrap(BASE_PROFILE);
  const disabledBootstrap = createBootstrap(BASE_PROFILE, {
    enableManagedWorktrees: false,
  });
  const enabledBootstrap = createBootstrap(BASE_PROFILE, {
    enableManagedWorktrees: true,
  });
  const desktopBootstrap = createBootstrap({
    ...BASE_PROFILE,
    shellKind: "desktop",
  });
  const environmentBootstrap = createBootstrap(BASE_PROFILE, {
    resolveEnvironment: () => ({
      ...emptyEnvironment,
      runtimeEnv: { KESTREL_ENABLE_MANAGED_WORKTREES: "true" },
    }),
  });

  try {
    assert.equal(defaultBootstrap.kestrel.getManagedTaskWorktreeService(), undefined);
    assert.equal(disabledBootstrap.kestrel.getManagedTaskWorktreeService(), undefined);
    assert.notEqual(enabledBootstrap.kestrel.getManagedTaskWorktreeService(), undefined);
    assert.notEqual(desktopBootstrap.kestrel.getManagedTaskWorktreeService(), undefined);
    assert.notEqual(environmentBootstrap.kestrel.getManagedTaskWorktreeService(), undefined);
  } finally {
    await Promise.all([
      defaultBootstrap.close(),
      disabledBootstrap.close(),
      enabledBootstrap.close(),
      desktopBootstrap.close(),
      environmentBootstrap.close(),
    ]);
  }
});

test("required managed Workspace policy injects the Environment-owned canonical root", () => {
  assert.deepEqual(
    applyRequiredManagedWorkspacePolicy(undefined, {
      KESTREL_REQUIRE_MANAGED_WORKTREE: "true",
      KESTREL_WORKSPACE_ID: "workspace-1",
      KESTREL_WORKSPACE_ROOT: "/workspace",
      KESTREL_MANAGED_WORKTREE_ISOLATION: "session",
    }),
    {
      workspaceId: "workspace-1",
      workspaceRoot: "/workspace",
      appRoot: ".",
      commands: {},
      managedWorktreeRequired: true,
      sourceWorkspaceRoot: "/workspace",
      managedWorktreeIsolation: "session",
    },
  );
});

test("required managed Workspace policy cannot be weakened by a client turn", () => {
  assert.deepEqual(
    applyRequiredManagedWorkspacePolicy(
      {
        workspaceId: "client-workspace",
        workspaceRoot: "/tmp/client-root",
        appRoot: "client-app",
        commands: { test: "pnpm test" },
        managedWorktreeRequired: false,
      },
      {
        KESTREL_REQUIRE_MANAGED_WORKTREE: "true",
        KESTREL_WORKSPACE_ID: "workspace-1",
        KESTREL_WORKSPACE_ROOT: "/workspace",
        KESTREL_MANAGED_WORKTREE_ISOLATION: "session",
      },
    ),
    {
      workspaceId: "workspace-1",
      workspaceRoot: "/workspace",
      appRoot: ".",
      commands: {},
      managedWorktreeRequired: true,
      sourceWorkspaceRoot: "/workspace",
      managedWorktreeIsolation: "session",
    },
  );
});

test("required managed Workspace policy fails closed when its root binding is incomplete", () => {
  assert.throws(
    () =>
      applyRequiredManagedWorkspacePolicy(undefined, {
        KESTREL_REQUIRE_MANAGED_WORKTREE: "true",
        KESTREL_WORKSPACE_ID: "workspace-1",
      }),
    /requires KESTREL_WORKSPACE_ID and KESTREL_WORKSPACE_ROOT/u,
  );
});

test("gateway-managed profiles use the credential broker path instead of provider environment defaults", () => {
  const brokeredGateway = { call: async <T>() => ({ ok: true }) as T } satisfies ModelGateway;
  let capturedProfile: TuiProfile | undefined;

  const resolved = createModelGatewayForProfile(
    {
      ...BASE_PROFILE,
      modelProvider: "openrouter",
      model: "openai/gpt-5.4",
      modelCredential: {
        source: "kestrel-one",
        runId: "run-managed",
        organizationId: "org-acme",
        environmentId: "environment-default",
        gatewayId: "gateway-openrouter",
        rawModelId: "openai/gpt-5.4",
        provider: "openrouter",
      },
    },
    {
      createGatewayManaged(profile) {
        capturedProfile = profile;
        return brokeredGateway;
      },
    },
  );

  assert.equal(resolved, brokeredGateway);
  assert.equal(capturedProfile?.model, "openai/gpt-5.4");
  assert.equal(capturedProfile?.modelCredential?.gatewayId, "gateway-openrouter");
});

test("non-managed profiles retain their environment-backed provider behavior", () => {
  const original = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "runner-environment-key";
  try {
    assert.doesNotThrow(() =>
      createModelGatewayForProfile({
        ...BASE_PROFILE,
        modelProvider: "openrouter",
        model: "openai/gpt-5.4",
      })
    );
  } finally {
    if (original === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = original;
    }
  }
});

test("non-model runtime surfaces initialize before environment provider credentials are present", async () => {
  const original = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const gateway = createModelGatewayForProfile({
      ...BASE_PROFILE,
      modelProvider: "openrouter",
      model: "openai/gpt-5.4",
    });
    await assert.rejects(
      gateway.call({ input: "model admission should resolve credentials now" }),
      /OPENROUTER_API_KEY is required/u
    );
  } finally {
    if (original === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = original;
    }
  }
});

test("model gateway treats an explicit environment as authoritative", async () => {
  const original = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "ambient-key-must-not-leak";
  try {
    const gateway = createModelGatewayForProfile({
      ...BASE_PROFILE,
      modelProvider: "openrouter",
      model: "openai/gpt-5.4",
    }, { env: {} });
    await assert.rejects(
      gateway.call({ input: "explicit runtime environment only" }),
      /OPENROUTER_API_KEY is required/u,
    );
  } finally {
    if (original === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = original;
    }
  }
});
