import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CAPABILITY_DESCRIPTOR_VERSION,
  MODEL_PROVIDER_ADAPTERS_V1,
  MODEL_PROVIDER_IDENTITIES_V1,
  MODEL_REGISTRATION_VERSION,
  MODEL_REQUEST_VERSION,
  MODEL_RESPONSE_VERSION,
  PROVIDER_RUNTIME_CONFIGURATION_VERSION,
  adaptModelRequestV0ToV1,
  assertCurrentModelRegistrationV1,
  canonicalModelRegistrationJsonV1,
  createModelRegistrationV1,
  createLumiModelGateway,
  createRunPodModelGateway,
  createAnthropicModelGatewayFromEnv,
  createLmStudioModelGatewayFromEnv,
  createOllamaModelGatewayFromEnv,
  createOpenAiModelGatewayFromEnv,
  createOpenRouterModelGatewayFromEnv,
  getModelProviderAdapterV1,
  normalizeModelResponseV1,
  parseModelCapabilityDescriptorV1,
  parseModelRegistrationV1,
  parseModelRequestV1,
  parseProviderRuntimeConfigurationV1,
  type ModelCapabilityDescriptorV1,
  type ModelRegistrationAuthoringV1,
} from "../../src/index.js";
import type { ModelResponse } from "../../src/kestrel/contracts/model-io.js";
import { createVersionedProviderInvokerV1 } from "../../models/VersionedModelBoundary.js";

test("model request V1 parsing is strict and the explicit V0 adapter is bounded", () => {
  const legacy = {
    model: "gpt-test",
    input: { prompt: "hello" },
    messages: [{ role: "user" as const, content: "hello" }],
    responseFormat: "text" as const,
  };
  const adapted = adaptModelRequestV0ToV1(legacy);
  assert.equal(adapted.version, MODEL_REQUEST_VERSION);
  assert.deepEqual(adapted.input, { prompt: "hello" });
  assert.throws(
    () => adaptModelRequestV0ToV1({ ...legacy, version: "model_request_v0" } as never),
    /must not contain a version/u,
  );
  assert.throws(
    () => parseModelRequestV1({ ...adapted, version: "model_request_v2" }),
    /version must be/u,
  );
  assert.throws(
    () => parseModelRequestV1({ ...adapted, surprise: true }),
    /unknown field 'surprise'/u,
  );
  assert.throws(
    () => parseModelRequestV1({
      ...adapted,
      providerOptions: { openai: { maxTokens: 1.5 } },
    }),
    /positive safe integer/u,
  );
});

test("provider entry upgrades legacy requests and returns a strict V1 response", async () => {
  let observedVersion: string | undefined;
  const invoke = createVersionedProviderInvokerV1(async (request) => {
    observedVersion = (request as { version?: string }).version;
    return {
      text: "ok",
      toolIntents: [],
      provider: {
        name: "openai",
        model: request.model ?? "gpt-test",
        endpoint: "responses",
      },
    };
  });

  const response = await invoke({ model: "gpt-test", input: "hello" });
  assert.equal(observedVersion, MODEL_REQUEST_VERSION);
  assert.equal((response as { version?: string }).version, MODEL_RESPONSE_VERSION);

  await assert.rejects(
    invoke({ version: "model_request_v2", input: "hello" } as never),
    /version must be/u,
  );
  assert.throws(
    () => normalizeModelResponseV1({
      version: "model_response_v2",
      toolIntents: [],
      provider: { name: "openai", model: "gpt-test", endpoint: "responses" },
    } as never),
    /version must be/u,
  );
  assert.throws(
    () => normalizeModelResponseV1({
      text: "ok",
      toolIntents: [],
      provider: { name: "openai", model: "gpt-test", endpoint: "responses" },
      surprise: true,
    } as never),
    /unknown field 'surprise'/u,
  );
});

test("capability descriptors cover all routing-relevant capability classes", () => {
  const parsed = parseModelCapabilityDescriptorV1(capabilities());
  assert.deepEqual(parsed.structuredOutput.modes, ["json_object", "json_schema"]);
  assert.deepEqual(parsed.inputModalities, ["text", "image"]);
  assert.deepEqual(parsed.contextLimit, { kind: "known", tokens: 128_000 });
  assert.deepEqual(parsed.outputLimit, { kind: "known", tokens: 16_000 });
  assert.deepEqual(parsed.cache, { read: true, write: false, scope: "provider" });
  assert.throws(
    () => parseModelCapabilityDescriptorV1({
      ...capabilities(),
      inputModalities: ["image"],
    }),
    /must include 'text'/u,
  );
  assert.throws(
    () => parseModelCapabilityDescriptorV1({
      ...capabilities(),
      reasoningModes: ["off", "off"],
    }),
    /contains duplicates/u,
  );
  assert.throws(
    () => parseModelCapabilityDescriptorV1({
      ...capabilities(),
      outputLimit: { kind: "model_specific", tokens: 10 },
    }),
    /tokens is forbidden/u,
  );
});

test("provider runtime configuration binds exact identity, protocol, auth, and controls", () => {
  const parsed = parseProviderRuntimeConfigurationV1(providerConfiguration());
  assert.equal(parsed.providerId, "openai");
  assert.equal(parsed.endpoint, "https://api.openai.com/v1");
  assert.deepEqual(parsed.allowedHeaders, ["openai-organization", "openai-project"]);
  assert.throws(
    () => parseProviderRuntimeConfigurationV1({
      ...providerConfiguration(),
      protocol: "anthropic",
    }),
    /must use protocol 'openai'/u,
  );
  assert.throws(
    () => parseProviderRuntimeConfigurationV1({
      ...providerConfiguration(),
      endpoint: "https://secret@example.com/v1",
    }),
    /must not contain credentials/u,
  );
  assert.throws(
    () => parseProviderRuntimeConfigurationV1({
      ...providerConfiguration(),
      allowedHeaders: ["X-Test", "x-test"],
    }),
    /contains duplicates/u,
  );
});

test("model registrations are canonical, fingerprinted, and stale revisions fail closed", () => {
  const authoring = registrationAuthoring();
  const registration = createModelRegistrationV1(authoring);
  assert.match(registration.fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(parseModelRegistrationV1(registration), registration);
  assert.equal(
    canonicalModelRegistrationJsonV1(registration),
    canonicalModelRegistrationJsonV1(structuredClone(registration)),
  );
  const reordered = createModelRegistrationV1({
    ...authoring,
    capabilities: {
      ...authoring.capabilities,
      structuredOutput: { modes: ["json_schema", "json_object"] },
      inputModalities: ["image", "text"],
    },
    providerConfiguration: {
      ...authoring.providerConfiguration,
      allowedHeaders: ["openai-organization", "OpenAI-Project"],
    },
  });
  assert.equal(reordered.fingerprint, registration.fingerprint);
  assert.throws(
    () => parseModelRegistrationV1({ ...registration, modelId: "gpt-tampered" }),
    /fingerprint does not match/u,
  );
  assert.throws(
    () => assertCurrentModelRegistrationV1(registration, { revision: "provider-revision-2" }),
    /revision is stale/u,
  );
  assert.throws(
    () => createModelRegistrationV1({
      ...authoring,
      providerId: "anthropic",
    }),
    /identity disagrees/u,
  );
});

test("provider registry contains every exact shipped identity once", () => {
  const expectedFactories = {
    openrouter: createOpenRouterModelGatewayFromEnv,
    openai: createOpenAiModelGatewayFromEnv,
    anthropic: createAnthropicModelGatewayFromEnv,
    ollama: createOllamaModelGatewayFromEnv,
    lmstudio: createLmStudioModelGatewayFromEnv,
    lumi: createLumiModelGateway,
    runpod: createRunPodModelGateway,
  } as const;
  assert.deepEqual(
    MODEL_PROVIDER_ADAPTERS_V1.map((entry) => entry.providerId),
    MODEL_PROVIDER_IDENTITIES_V1,
  );
  assert.equal(
    new Set(MODEL_PROVIDER_ADAPTERS_V1.map((entry) => entry.providerId)).size,
    MODEL_PROVIDER_IDENTITIES_V1.length,
  );
  for (const providerId of MODEL_PROVIDER_IDENTITIES_V1) {
    const entry = getModelProviderAdapterV1(providerId);
    assert.equal(entry.providerId, providerId);
    assert.equal(entry.conformanceFixture.expectedProviderId, providerId);
    assert.equal(entry.conformanceFixture.request.version, MODEL_REQUEST_VERSION);
    assert.equal(typeof entry.factory, "function");
    assert.equal(entry.factory, expectedFactories[providerId]);
    assert.equal(entry.capabilityDeclaration.version, MODEL_CAPABILITY_DESCRIPTOR_VERSION);
  }
  assert.notEqual(
    getModelProviderAdapterV1("openai").factory,
    getModelProviderAdapterV1("lumi").factory,
  );
  assert.notEqual(
    getModelProviderAdapterV1("lumi").factory,
    getModelProviderAdapterV1("runpod").factory,
  );
});

test("shared OpenAI-compatible transport preserves Lumi and RunPod identities", async () => {
  for (const providerId of ["lumi", "runpod"] as const) {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      id: `${providerId}-request`,
      model: `${providerId}-model`,
      choices: [{ message: { content: "ok", tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const options = {
      fetchImpl,
      envConfig: {
        apiKey: "test-key",
        baseUrl: `https://${providerId}.example/v1`,
        model: `${providerId}-model`,
      },
      retryCount: 0,
    };
    const gateway = providerId === "lumi"
      ? createLumiModelGateway(options)
      : createRunPodModelGateway(options);
    const response = await gateway.call<ModelResponse>({ input: "hello" });
    assert.equal(response.provider.name, providerId);
    assert.equal((response as { version?: string }).version, MODEL_RESPONSE_VERSION);
  }
});

function capabilities(): ModelCapabilityDescriptorV1 {
  return {
    version: MODEL_CAPABILITY_DESCRIPTOR_VERSION,
    tools: { nativeToolCalling: true, parallelToolCalls: true },
    structuredOutput: { modes: ["json_object", "json_schema"] },
    streaming: true,
    reasoningModes: ["off", "summary", "provider_visible"],
    inputModalities: ["text", "image"],
    contextLimit: { kind: "known", tokens: 128_000 },
    outputLimit: { kind: "known", tokens: 16_000 },
    cache: { read: true, write: false, scope: "provider" },
  };
}

function providerConfiguration() {
  return {
    version: PROVIDER_RUNTIME_CONFIGURATION_VERSION,
    providerId: "openai" as const,
    protocol: "openai" as const,
    authentication: {
      mode: "required" as const,
      credentialReference: { source: "local-core", id: "provider.openai.default" },
    },
    endpoint: "https://api.openai.com/v1/",
    timeoutMs: 60_000,
    allowedHeaders: ["OpenAI-Project", "openai-organization"],
    region: "us",
    dataHandling: "provider_managed" as const,
  };
}

function registrationAuthoring(): ModelRegistrationAuthoringV1 {
  return {
    version: MODEL_REGISTRATION_VERSION,
    registrationId: "openai:gpt-test:provider-revision-1",
    providerId: "openai",
    modelId: "gpt-test",
    capabilities: capabilities(),
    providerConfiguration: providerConfiguration(),
    revision: "provider-revision-1",
    priceReference: "prices:openai:gpt-test:2026-08-04",
    calibrationReference: "calibration:openai:gpt-test:1",
    latencyReference: "slo:openai:gpt-test:1",
  };
}
