import test from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_REGISTRATION_V2_VERSION,
  MODEL_REQUEST_V2_VERSION,
  createModelRegistrationV2,
  createModelRequestV2,
  normalizeModelRequestV2,
} from "../../src/kestrel/contracts/model-registration.js";
import { hashCanonical } from "../../src/kestrel/contracts/tool-contract.js";
import {
  createExactEffectiveModelContractResolverV1,
  legacyEffectiveModelContractResolverV1,
  resolveExactModelEndpointV1,
} from "../../src/kestrel/effective-model-contract.js";

test("exact admission binds one qualified request to its registration and endpoint", () => {
  const registration = qualifiedRegistration();
  const resolver = createExactEffectiveModelContractResolverV1({
    registration,
    routeBinding: bindingFor(registration),
    endpoint: "responses",
  });
  const admission = resolver.admit({ request: strictRequest() });
  assert.ok(!(admission instanceof Promise));
  const admittedRequest = normalizeModelRequestV2(admission.request);
  assert.equal(admission.request.version, MODEL_REQUEST_V2_VERSION);
  assert.equal(admittedRequest.model, registration.modelId);
  assert.equal(admittedRequest.requirements.endpoint, "responses");
  assert.equal(admission.contract.registrationFingerprint, registration.fingerprint);
  assert.equal(admission.contract.requestFingerprint, admittedRequest.fingerprints.request);
  assert.equal(admission.contract.schemaHash, admittedRequest.fingerprints.schema);
  assert.equal(admission.contract.toolSurfaceHash, admittedRequest.fingerprints.toolSurface);
});

test("exact admission rejects stale capability evidence before a gateway can be called", () => {
  const base = qualifiedRegistration();
  const { fingerprint: _fingerprint, ...authoring } = base;
  const registration = createModelRegistrationV2({
    ...authoring,
    capabilities: {
      ...base.capabilities,
      providerStrictSchema: {
        ...base.capabilities.providerStrictSchema,
        state: "stale",
      },
    },
  });
  const resolver = createExactEffectiveModelContractResolverV1({
    registration,
    routeBinding: bindingFor(registration),
    endpoint: "responses",
  });
  const preSpend = resolver.describePreSpendAttempt?.({ request: strictRequest() });
  assert.ok(preSpend !== undefined && !(preSpend instanceof Promise));
  assert.equal(preSpend?.contract?.endpointCodec, "openai.responses.v2");
  assert.equal(preSpend?.contract?.runtimeRole, "agent.loop");
  const preSpendRequest = normalizeModelRequestV2(preSpend!.request);
  assert.equal(preSpendRequest.requirements.output.assurance, "provider_strict_schema");
  assert.equal(preSpendRequest.requirements.tools.choice, "required");
  assert.equal(preSpendRequest.requirements.tools.strictArguments, true);
  assert.throws(
    () => resolver.admit({ request: strictRequest() }),
    (error: unknown) => (error as { code?: string }).code === "MODEL_QUALIFICATION_STALE",
  );
});

test("exact admission rejects a route binding from a different credential revision", () => {
  const registration = qualifiedRegistration();
  const binding = {
    ...bindingFor(registration),
    credentialRevision: 2,
  };
  assert.throws(
    () => createExactEffectiveModelContractResolverV1({
      registration,
      routeBinding: binding,
      endpoint: "responses",
    }),
    (error: unknown) => (error as { code?: string }).code === "MODEL_ROUTE_MISMATCH",
  );
});

test("legacy admission permits plain text and rejects structured work", () => {
  const plain = legacyEffectiveModelContractResolverV1.admit({
    request: { input: "plain text" },
  });
  assert.ok(!(plain instanceof Promise));
  assert.equal(plain.contract.status, "legacy_compatibility");
  assert.throws(
    () => legacyEffectiveModelContractResolverV1.admit({ request: strictRequest() }),
    (error: unknown) => (error as { code?: string }).code === "MODEL_LEGACY_CONTRACT_UNSUPPORTED",
  );
});

test("legacy admission preserves runtime metadata outside the contract view", async () => {
  const request = {
    input: "plain text",
    metadata: {
      contextSections: [{ count: { tokens: 42 } }],
    },
  };
  const admission = await legacyEffectiveModelContractResolverV1.admit({
    request,
  });
  assert.equal(admission.request, request);
  assert.equal(admission.contract.status, "legacy_compatibility");
});

test("endpoint selection is explicit for each registered V2 codec", () => {
  assert.equal(resolveExactModelEndpointV1("openai.responses.v2"), "responses");
  assert.equal(resolveExactModelEndpointV1("openrouter.chat.v2"), "chat");
  assert.equal(resolveExactModelEndpointV1("anthropic.messages.v2"), "messages");
  assert.throws(
    () => resolveExactModelEndpointV1("openai.future.v3"),
    (error: unknown) =>
      (error as { code?: string }).code === "MODEL_ENDPOINT_CODEC_UNSUPPORTED",
  );
});

function strictRequest() {
  return createModelRequestV2({
    version: MODEL_REQUEST_V2_VERSION,
    model: "gpt-contract-test",
    input: "return the required JSON",
    responseFormat: "json",
    responseSchema: {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
      additionalProperties: false,
    },
    tools: [{
      name: "record",
      description: "Record the result.",
      inputSchema: {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
        additionalProperties: false,
      },
    }],
    requirements: {
      runtimeRole: "agent.loop",
      output: { kind: "json_schema", assurance: "provider_strict_schema", schemaName: "result" },
      tools: { choice: "required", strictArguments: true, parallelism: "forbidden" },
      reasoning: { mode: "off", continuationKinds: [] },
      streaming: { required: false, terminalBehavior: "not_required" },
      inputModalities: ["text"],
      endpoint: "responses",
    },
  });
}

function qualifiedRegistration() {
  const providerEvidence = [{
    source: "provider" as const,
    observedRevision: "registration-1",
    observedAt: "2026-08-26T12:00:00.000Z",
    adapterRevision: "adapter-1",
    credentialRevision: "1",
    retainedPayloadHash: hash("a"),
  }];
  const qualificationEvidence = [{
    source: "qualification" as const,
    observedRevision: "registration-1",
    observedAt: "2026-08-26T12:01:00.000Z",
    adapterRevision: "adapter-1",
    credentialRevision: "1",
    qualificationRevision: "qualification-1",
    retainedPayloadHash: hash("b"),
  }];
  const qualified = { state: "qualified" as const, evidence: qualificationEvidence };
  return createModelRegistrationV2({
    version: MODEL_REGISTRATION_V2_VERSION,
    registrationId: "openai:gpt-contract-test",
    providerId: "openai",
    modelId: "gpt-contract-test",
    providerConfiguration: {
      version: "provider_runtime_configuration_v1",
      providerId: "openai",
      protocol: "openai",
      authentication: { mode: "required", credentialReference: { source: "local-core", id: "provider.openai.default" } },
      endpoint: "https://api.openai.example/v1",
      timeoutMs: 60_000,
      allowedHeaders: [],
      dataHandling: "provider_managed",
    },
    route: {
      apiEndpoint: "https://api.openai.example/v1",
      endpointCodec: "openai.responses.v2",
      routing: { kind: "fixed", policyId: "openai:responses", requireParameters: true },
    },
    revision: "registration-1",
    adapterRevision: "adapter-1",
    credentialRevision: "1",
    providerEvidence,
    qualification: { state: "qualified", revision: "qualification-1", checkedAt: "2026-08-26T12:01:00.000Z", probeHash: hash("c") },
    capabilities: {
      jsonSyntax: qualified,
      localSchemaValidation: qualified,
      providerStrictSchema: qualified,
      nativeTools: qualified,
      requiredToolChoice: qualified,
      strictToolInputs: qualified,
      parallelToolCalls: qualified,
      reasoning: { ...qualified, modes: ["off"] },
      continuation: { ...qualified, kinds: [] },
      streaming: { ...qualified, terminalEvents: ["response.completed"] },
      inputModalities: { text: { state: "declared", evidence: providerEvidence }, image: { state: "unsupported", evidence: providerEvidence } },
      limits: { context: { kind: "model_specific" }, output: { kind: "model_specific" }, evidence: providerEvidence },
      cache: { state: "unsupported", evidence: providerEvidence, read: false, write: false, scope: "none" },
    },
  });
}

function bindingFor(registration: ReturnType<typeof qualifiedRegistration>) {
  return {
    version: "model_credential_route_binding_v2" as const,
    status: "qualified" as const,
    provider: "openai" as const,
    rawModelId: registration.modelId,
    registrationId: registration.registrationId,
    registrationRevision: registration.revision,
    registrationFingerprint: registration.fingerprint,
    qualificationRevision: registration.qualification.revision!,
    apiEndpoint: registration.route.apiEndpoint,
    endpointCodec: registration.route.endpointCodec,
    routingPolicyFingerprint: hashCanonical(registration.route.routing),
    requiredRole: "agent.loop",
    credentialRevision: 1,
  };
}

function hash(character: string) {
  return `sha256:${character.repeat(64)}`;
}
