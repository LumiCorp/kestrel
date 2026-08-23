import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintSandboxCapabilityProfileV1, normalizeSandboxCapabilityProfileV2, normalizeSandboxCapabilitySelectionV2, parseSandboxCapabilityLeaseBindingV2, parseSandboxCapabilityProfileV1, parseSandboxCapabilityProfilesV1, parseSandboxCapabilityProfileV2, parseSandboxCapabilitySelectionV1, parseSandboxCapabilitySelectionV2 } from "../../src/kestrel/contracts/sandbox-capability.js";
import { fingerprintResolvedProfile } from "../../src/profile/kestrelOnePolicy.js";

const authored = { version: 1, capabilityId: "tavily.search.read", operations: ["search"], resource: "https://api.tavily.com/search", audience: { tenantId: "t", environmentId: "e" }, maxRequests: 1, maxQueryChars: 100, maxResults: 5, maxResponseBytes: 4096, timeoutMs: 1000, maxExpiryMs: 5000, brokerAuthority: { authorityId: "b", revision: "r" } };

test("sandbox capability profile is strict, canonical, and fingerprinted", () => {
  const parsed = parseSandboxCapabilityProfileV1(authored);
  assert.match(fingerprintSandboxCapabilityProfileV1(parsed), /^[a-f0-9]{64}$/u);
  assert.throws(() => parseSandboxCapabilityProfileV1({ ...authored, operations: ["*"] }), /exactly search/u);
  assert.throws(() => parseSandboxCapabilityProfileV1({ ...authored, destination: "evil" }), /unknown field/u);
  assert.throws(() => parseSandboxCapabilityProfilesV1([authored, authored]), /duplicate sandbox capability ID/u);
  const baseProfile = { id: "profile", codeMode: { capabilities: [authored] } };
  assert.notEqual(fingerprintResolvedProfile(baseProfile as never), fingerprintResolvedProfile({ ...baseProfile, codeMode: { capabilities: [{ ...authored, maxResults: 4 }] } } as never));
});

test("model selection accepts only capability ID and approved nonsecret input", () => {
  assert.deepEqual(parseSandboxCapabilitySelectionV1({ capabilityId: "tavily.search.read", input: { query: "q", maxResults: 2 } }), { capabilityId: "tavily.search.read", input: { query: "q", maxResults: 2 } });
  for (const field of ["credentialReference", "destination", "adapter", "authority", "lease", "budget"]) assert.throws(() => parseSandboxCapabilitySelectionV1({ capabilityId: "tavily.search.read", input: { query: "q" }, [field]: "forged" }), /unknown field/u);
});

test("generic v2 capability contracts bind exact operation, resource, effect class, and action approval", () => {
  assert.deepEqual(normalizeSandboxCapabilityProfileV2(authored).effectClass, "read_only");
  assert.equal(normalizeSandboxCapabilitySelectionV2({ capabilityId: "tavily.search.read", input: { query: "legacy" } }).version, 2);
  const v2 = parseSandboxCapabilityProfileV2({
    version: 2, capabilityId: "example.lookup.read", operation: "lookup", resource: "https://api.example.com/lookup",
    effectClass: "read_only", audience: { tenantId: "t", environmentId: "e" }, maxRequests: 2, maxResponseBytes: 4096,
    timeoutMs: 1000, maxExpiryMs: 5000, brokerAuthority: { authorityId: "b", revision: "r" }, adapterConfig: { maxItems: 4 },
  });
  assert.equal(v2.effectClass, "read_only");
  assert.deepEqual(parseSandboxCapabilitySelectionV2({ version: 2, capabilityId: "example.lookup.read", operation: "lookup", input: { query: "q" } }).input, { query: "q" });
  const binding = { version: 2, tenantId: "t", environmentId: "e", sessionId: "s", runId: "r", toolCallId: "call", profileFingerprint: "a".repeat(64), capabilityCatalogFingerprint: "b".repeat(64), executionBoundaryRevision: "boundary", capabilityId: "example.write", operation: "write", resource: "https://api.example.com/write", effectClass: "external_effect", audience: { tenantId: "t", environmentId: "e" }, brokerAuthority: { authorityId: "b", revision: "r" }, credentialReference: { credentialId: "tool.example", revision: "c" }, policyRevision: "p" };
  assert.throws(() => parseSandboxCapabilityLeaseBindingV2(binding), /action-bound approval/u);
  const exactApproval = { version: "runner_external_approval_binding_v1", approvalId: "approval-call", threadId: "thread", runId: "r", actionKey: "code.execute:call:example.write:write", payloadHash: `sha256:${"c".repeat(64)}`, toolClass: "external_side_effect", capabilities: ["code.execute", "example.write"], authorityKind: "runtime_policy", authorityRevision: "upstream-authority", requestedAt: "2026-08-23T12:00:00.000Z", expiresAt: "2026-08-23T12:01:00.000Z" };
  assert.equal(parseSandboxCapabilityLeaseBindingV2({ ...binding, approval: { approvalId: "approval-call", authorityRevision: "authority" }, externalApprovalBinding: exactApproval }).effectClass, "external_effect");
  assert.throws(() => parseSandboxCapabilityLeaseBindingV2({ ...binding, approval: { approvalId: "other", authorityRevision: "authority" }, externalApprovalBinding: exactApproval }), /identity is inconsistent/u);
});
