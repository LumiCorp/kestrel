import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintSandboxCapabilityProfileV1, parseSandboxCapabilityProfileV1, parseSandboxCapabilityProfilesV1, parseSandboxCapabilitySelectionV1 } from "../../src/kestrel/contracts/sandbox-capability.js";
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
