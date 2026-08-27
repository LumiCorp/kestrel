import assert from "node:assert/strict";
import test from "node:test";
import { createModelRegistrationV2 } from "../../../../src/kestrel/contracts/model-registration";
import {
  createHostedModelRegistration,
  withHostedModelRegistration,
} from "./hosted-model-registration";
import {
  hostedModelRoleUnavailableReason,
  isHostedModelRoleReady,
  readHostedModelReadiness,
} from "./hosted-model-readiness";

function pendingRegistration() {
  return createHostedModelRegistration({
    registrationId: "hosted:gateway-1:z-ai/glm-test",
    revision: "registration-1",
    observedAt: "2026-08-26T00:00:00.000Z",
    modelId: "z-ai/glm-test",
    credentialRevision: "7",
    providerConfiguration: {
      version: "provider_runtime_configuration_v1",
      providerId: "openrouter",
      protocol: "openrouter",
      authentication: {
        mode: "required",
        credentialReference: { source: "hosted", id: "provider.openrouter.hosted" },
      },
      endpoint: "https://openrouter.example/api/v1",
      timeoutMs: 15_000,
      allowedHeaders: [],
      dataHandling: "provider_managed",
    },
    providerEvidence: {
      provider: "openrouter",
      details: {
        id: "z-ai/glm-test",
        supported_parameters: ["response_format", "tools", "tool_choice", "strict_tool_inputs"],
        endpoints: [{
          id: "provider-a",
          supported_parameters: ["response_format", "tools", "tool_choice", "strict_tool_inputs"],
        }],
      },
    },
  });
}

function fullyQualifiedRegistration() {
  const pending = pendingRegistration().registration;
  const { fingerprint: _fingerprint, ...authoring } = pending;
  const evidence = {
    source: "qualification" as const,
    observedRevision: authoring.revision,
    observedAt: "2026-08-26T00:01:00.000Z",
    adapterRevision: authoring.adapterRevision,
    credentialRevision: "7",
    qualificationRevision: "hosted-agent-loop-v1",
    retainedPayloadHash: `sha256:${"a".repeat(64)}`,
  };
  const qualified = <T extends { evidence: readonly unknown[] }>(claim: T) => ({
    ...claim,
    state: "qualified" as const,
    evidence: [...claim.evidence, evidence],
  });
  return createModelRegistrationV2({
    ...authoring,
    qualification: {
      state: "qualified",
      revision: "hosted-agent-loop-v1",
      checkedAt: "2026-08-26T00:01:00.000Z",
      probeHash: `sha256:${"b".repeat(64)}`,
    },
    capabilities: {
      ...authoring.capabilities,
      providerStrictSchema: qualified(authoring.capabilities.providerStrictSchema),
      nativeTools: qualified(authoring.capabilities.nativeTools),
      requiredToolChoice: qualified(authoring.capabilities.requiredToolChoice),
      strictToolInputs: qualified(authoring.capabilities.strictToolInputs),
    },
  });
}

function readinessFor(metadata: unknown, credentialRevision: number | undefined = 7) {
  return readHostedModelReadiness({
    approved: true,
    gatewayEnabled: true,
    gatewayReachable: true,
    provider: "openrouter",
    modelId: "z-ai/glm-test",
    metadata,
    credentialRevision,
  });
}

test("legacy and pending hosted models stay visible but cannot serve agent.loop", () => {
  const legacy = readinessFor({});
  assert.equal(legacy.qualification, "legacy_unqualified");
  assert.deepEqual(legacy.eligibleRoles, []);
  assert.match(
    hostedModelRoleUnavailableReason(legacy, "agent.loop") ?? "",
    /exact registration/u,
  );

  const pending = pendingRegistration();
  const readiness = readinessFor(withHostedModelRegistration({ metadata: {}, ...pending }));
  assert.equal(readiness.declaration, "present");
  assert.equal(readiness.qualification, "pending");
  assert.deepEqual(readiness.eligibleRoles, []);
  assert.match(
    hostedModelRoleUnavailableReason(readiness, "agent.loop") ?? "",
    /last qualification is pending/u,
  );
});

test("a partial GLM qualification names the exact strict proof still missing", () => {
  const registration = fullyQualifiedRegistration();
  const { fingerprint: _fingerprint, ...authoring } = registration;
  const partial = createModelRegistrationV2({
    ...authoring,
    capabilities: {
      ...authoring.capabilities,
      strictToolInputs: {
        ...authoring.capabilities.strictToolInputs,
        state: "failed",
      },
    },
  });
  const readiness = readinessFor({ kestrelModelRegistrationV2: partial });
  assert.equal(isHostedModelRoleReady(readiness, "agent.loop"), false);
  assert.deepEqual(readiness.unavailableRoles[0]?.missingCapabilities, ["strict_tool_inputs"]);
  assert.match(
    readiness.unavailableRoles[0]?.reason ?? "",
    /strict_tool_inputs/u,
  );
});

test("only a current exact qualification enables the product-owned agent role", () => {
  const registration = fullyQualifiedRegistration();
  const readiness = readinessFor({ kestrelModelRegistrationV2: registration });
  assert.equal(readiness.identity, "exact");
  assert.equal(readiness.freshness, "current");
  assert.deepEqual(readiness.eligibleRoles, ["agent.loop"]);
  assert.equal(isHostedModelRoleReady(readiness, "agent.loop"), true);

  const stale = readinessFor({ kestrelModelRegistrationV2: registration }, 8);
  assert.equal(stale.identity, "stale");
  assert.equal(isHostedModelRoleReady(stale, "agent.loop"), false);
  assert.match(
    hostedModelRoleUnavailableReason(stale, "agent.loop") ?? "",
    /stale/u,
  );
});

test("a retained registration with another exact identity remains inspectable and unavailable", () => {
  const registration = fullyQualifiedRegistration();
  const { fingerprint: _fingerprint, ...authoring } = registration;
  const mismatched = createModelRegistrationV2({
    ...authoring,
    modelId: "z-ai/other-model",
  });
  const readiness = readinessFor({ kestrelModelRegistrationV2: mismatched });
  assert.equal(readiness.identity, "invalid");
  assert.equal(readiness.declaration, "present");
  assert.equal(readiness.registration?.revision, mismatched.revision);
  assert.equal(isHostedModelRoleReady(readiness, "agent.loop"), false);
  assert.match(
    hostedModelRoleUnavailableReason(readiness, "agent.loop") ?? "",
    /does not match/u,
  );
});
