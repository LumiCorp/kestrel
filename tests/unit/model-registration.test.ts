import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CAPABILITY_DESCRIPTOR_VERSION,
  MODEL_PROVIDER_ADAPTERS_V1,
  MODEL_PROVIDER_IDENTITIES_V1,
  MODEL_REGISTRATION_VERSION,
  MODEL_REGISTRATION_V2_VERSION,
  MODEL_REQUEST_VERSION,
  MODEL_REQUEST_V2_VERSION,
  MODEL_RESPONSE_VERSION,
  MODEL_RESPONSE_V2_VERSION,
  PROVIDER_RUNTIME_CONFIGURATION_VERSION,
  adaptModelRequestV0ToV1,
  adaptModelRequestV1ToV2,
  adaptModelRegistrationV1ToV2,
  assertCurrentModelRegistrationV1,
  assertCurrentModelRegistrationV2,
  canonicalModelRegistrationJsonV1,
  canonicalModelRegistrationJsonV2,
  canonicalModelRequestJsonV2,
  createModelRegistrationV1,
  createModelRegistrationV2,
  createModelRequestV2,
  createLumiModelGateway,
  createRunPodModelGateway,
  createAnthropicModelGatewayFromEnv,
  createLmStudioModelGatewayFromEnv,
  createOllamaModelGatewayFromEnv,
  createOpenAiModelGatewayFromEnv,
  createOpenRouterModelGatewayFromEnv,
  getModelProviderAdapterV1,
  normalizeModelResponseV1,
  normalizeModelResponseV2,
  parseModelCapabilityDescriptorV1,
  parseModelRegistrationV1,
  parseModelRegistrationV2,
  parseModelRequestV1,
  parseModelRequestV2,
  parseModelResponseV2,
  parseProviderRuntimeConfigurationV1,
  type ModelCapabilityDescriptorV1,
  type ModelRegistrationAuthoringV1,
  type ModelRegistrationAuthoringV2,
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
    () =>
      adaptModelRequestV0ToV1({
        ...legacy,
        version: "model_request_v0",
      } as never),
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
    () =>
      parseModelRequestV1({
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
  assert.equal(
    (response as { version?: string }).version,
    MODEL_RESPONSE_VERSION,
  );

  await assert.rejects(
    invoke({ version: "model_request_v2", input: "hello" } as never),
    /requirements must be an object/u,
  );
  assert.throws(
    () =>
      normalizeModelResponseV1({
        version: "model_response_v2",
        toolIntents: [],
        provider: { name: "openai", model: "gpt-test", endpoint: "responses" },
      } as never),
    /version must be/u,
  );
  assert.throws(
    () =>
      normalizeModelResponseV1({
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
  assert.deepEqual(parsed.structuredOutput.modes, [
    "json_object",
    "json_schema",
  ]);
  assert.deepEqual(parsed.inputModalities, ["text", "image"]);
  assert.deepEqual(parsed.contextLimit, { kind: "known", tokens: 128_000 });
  assert.deepEqual(parsed.outputLimit, { kind: "known", tokens: 16_000 });
  assert.deepEqual(parsed.cache, {
    read: true,
    write: false,
    scope: "provider",
  });
  assert.throws(
    () =>
      parseModelCapabilityDescriptorV1({
        ...capabilities(),
        inputModalities: ["image"],
      }),
    /must include 'text'/u,
  );
  assert.throws(
    () =>
      parseModelCapabilityDescriptorV1({
        ...capabilities(),
        reasoningModes: ["off", "off"],
      }),
    /contains duplicates/u,
  );
  assert.throws(
    () =>
      parseModelCapabilityDescriptorV1({
        ...capabilities(),
        outputLimit: { kind: "model_specific", tokens: 10 },
      }),
    /tokens is forbidden/u,
  );
  assert.throws(
    () =>
      parseModelCapabilityDescriptorV1({
        ...capabilities(),
        tools: { nativeToolCalling: false, parallelToolCalls: true },
      }),
    /parallelToolCalls requires nativeToolCalling/u,
  );
  assert.throws(
    () =>
      parseModelCapabilityDescriptorV1({
        ...capabilities(),
        tools: { nativeToolCalling: false, parallelToolCalls: false },
        structuredOutput: { modes: ["tool_contract"] },
      }),
    /'tool_contract' requires nativeToolCalling/u,
  );
});

test("provider runtime configuration binds exact identity, protocol, auth, and controls", () => {
  const parsed = parseProviderRuntimeConfigurationV1(providerConfiguration());
  assert.equal(parsed.providerId, "openai");
  assert.equal(parsed.endpoint, "https://api.openai.com/v1");
  assert.deepEqual(parsed.allowedHeaders, [
    "openai-organization",
    "openai-project",
  ]);
  assert.throws(
    () =>
      parseProviderRuntimeConfigurationV1({
        ...providerConfiguration(),
        protocol: "anthropic",
      }),
    /must use protocol 'openai'/u,
  );
  assert.throws(
    () =>
      parseProviderRuntimeConfigurationV1({
        ...providerConfiguration(),
        endpoint: "https://secret@example.com/v1",
      }),
    /must not contain credentials/u,
  );
  for (const query of [
    "api_key=secret",
    "token=secret",
    "signature=secret",
  ] as const) {
    assert.throws(
      () =>
        parseProviderRuntimeConfigurationV1({
          ...providerConfiguration(),
          endpoint: `https://api.openai.com/v1?${query}`,
        }),
      /must not contain a query string/u,
    );
  }
  assert.throws(
    () =>
      parseProviderRuntimeConfigurationV1({
        ...providerConfiguration(),
        endpoint: "https://api.openai.com/v1#credential-fragment",
      }),
    /must not contain a fragment/u,
  );
  assert.throws(
    () =>
      parseProviderRuntimeConfigurationV1({
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
    () =>
      parseModelRegistrationV1({ ...registration, modelId: "gpt-tampered" }),
    /fingerprint does not match/u,
  );
  assert.throws(
    () =>
      assertCurrentModelRegistrationV1(registration, {
        revision: "provider-revision-2",
      }),
    /revision is stale/u,
  );
  assert.throws(
    () =>
      createModelRegistrationV1({
        ...authoring,
        providerId: "anthropic",
      }),
    /identity disagrees/u,
  );
});

test("V2 registrations bind exact route, evidence, qualification, and each capability", () => {
  const authoring = registrationAuthoringV2();
  const registration = createModelRegistrationV2(authoring);
  assert.match(registration.fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(parseModelRegistrationV2(registration), registration);
  assert.equal(
    canonicalModelRegistrationJsonV2(registration),
    canonicalModelRegistrationJsonV2(structuredClone(registration)),
  );
  const reordered = createModelRegistrationV2({
    ...authoring,
    route: {
      ...authoring.route,
      routing: {
        ...authoring.route.routing,
        allowedEndpointIds: ["west", "east"],
      },
    },
    capabilities: {
      ...authoring.capabilities,
      reasoning: {
        ...authoring.capabilities.reasoning,
        modes: ["provider_visible", "off"],
      },
    },
  });
  assert.equal(reordered.fingerprint, registration.fingerprint);
  for (const changed of [
    { route: { ...authoring.route, endpointCodec: "openai_chat_v2" } },
    { adapterRevision: "adapter-revision-2" },
    { credentialRevision: "credential-revision-2" },
  ]) {
    assert.notEqual(
      createModelRegistrationV2({ ...authoring, ...changed }).fingerprint,
      registration.fingerprint,
    );
  }
  assert.throws(
    () =>
      parseModelRegistrationV2({
        ...registration,
        route: {
          ...registration.route,
          apiEndpoint: "https://api.example.test/v2",
        },
      }),
    /route endpoint disagrees/u,
  );
  assert.throws(
    () =>
      createModelRegistrationV2({
        ...authoring,
        providerEvidence: [
          { ...authoring.providerEvidence[0]!, observedAt: undefined },
        ],
      }),
    /observedAt is required/u,
  );
  assert.throws(
    () =>
      createModelRegistrationV2({
        ...authoring,
        capabilities: {
          ...authoring.capabilities,
          nativeTools: {
            state: "qualified",
            evidence: authoring.providerEvidence,
          },
        },
      }),
    /requires qualification evidence/u,
  );
  assert.throws(
    () =>
      assertCurrentModelRegistrationV2(registration, {
        revision: registration.revision,
        qualificationRevision: "qualification-revision-2",
      }),
    /qualification revision is stale/u,
  );
});

test("V2 provider-neutral requirements are canonical and reject conflicting legacy semantics", () => {
  const request = createModelRequestV2(requestAuthoringV2());
  assert.deepEqual(parseModelRequestV2(request), request);
  assert.equal(
    canonicalModelRequestJsonV2(request),
    canonicalModelRequestJsonV2(structuredClone(request)),
  );
  assert.match(request.fingerprints.request, /^sha256:[0-9a-f]{64}$/u);
  assert.match(request.fingerprints.schema, /^sha256:[0-9a-f]{64}$/u);
  assert.match(request.fingerprints.toolSurface, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(
    createModelRequestV2({
      ...requestAuthoringV2(),
      requirements: {
        ...requestAuthoringV2().requirements,
        runtimeRole: "evaluation",
      },
    }).fingerprints.request,
    request.fingerprints.request,
  );
  assert.throws(
    () =>
      createModelRequestV2({
        ...requestAuthoringV2(),
        requirements: {
          ...requestAuthoringV2().requirements,
          tools: { ...requestAuthoringV2().requirements.tools, choice: "auto" },
        },
      }),
    /conflicts with legacy provider tool choice/u,
  );
  assert.throws(
    () =>
      createModelRequestV2({
        ...requestAuthoringV2(),
        metadata: { authorization: "secret" },
      }),
    /secret-bearing field/u,
  );
  assert.throws(
    () => parseModelRequestV2({ ...request, surprise: true }),
    /unknown field 'surprise'/u,
  );
});

test("V1 compatibility is explicit and legacy registrations are plain-text-only", () => {
  const legacyRegistration = adaptModelRegistrationV1ToV2(
    createModelRegistrationV1(registrationAuthoring()),
  );
  assert.equal(legacyRegistration.qualification.state, "legacy_unqualified");
  assert.equal(legacyRegistration.route.endpointCodec, "legacy_unqualified");
  assert.equal(legacyRegistration.capabilities.jsonSyntax.state, "unsupported");
  assert.equal(
    legacyRegistration.capabilities.nativeTools.state,
    "unsupported",
  );
  assert.equal(legacyRegistration.capabilities.streaming.state, "unsupported");

  const legacyRequest = adaptModelRequestV1ToV2(
    adaptModelRequestV0ToV1({
      input: "hello",
      responseFormat: "json",
      tools: [toolSpec()],
    }),
  );
  assert.equal(legacyRequest.requirements.runtimeRole, "legacy");
  assert.equal(legacyRequest.requirements.output.assurance, "json_syntax");
  assert.equal(legacyRequest.requirements.tools.choice, "auto");
  assert.equal(legacyRequest.requirements.tools.parallelism, "forbidden");
  assert.throws(
    () =>
      adaptModelRequestV1ToV2(
        adaptModelRequestV0ToV1({
          input: "hello",
          providerOptions: {
            openai: { toolChoice: "required" },
            openrouter: { toolChoice: "auto" },
          },
        }),
      ),
    /legacy provider tool choice options conflict/u,
  );
});

test("V2 response terminals carry validation proof without raw provider payloads", () => {
  const response = parseModelResponseV2({
    version: MODEL_RESPONSE_V2_VERSION,
    text: "ok",
    toolIntents: [],
    provider: { name: "openai", model: "gpt-test", endpoint: "responses" },
    terminal: {
      state: "completed",
      visibleOutputStarted: true,
      providerTerminalEvent: "response.completed",
    },
    validation: {
      state: "passed",
      schemaHash: hash(),
      toolSurfaceHash: hash("b"),
    },
  });
  assert.equal(response.terminal.state, "completed");
  assert.equal(response.validation.state, "passed");
  assert.throws(
    () =>
      parseModelResponseV2({ ...response, rawResponse: { token: "secret" } }),
    /unknown field 'rawResponse'/u,
  );
  assert.throws(
    () =>
      parseModelResponseV2({
        ...response,
        terminal: { state: "malformed", visibleOutputStarted: false },
        validation: { state: "not_requested" },
      }),
    /requires failed validation/u,
  );
  assert.equal(
    normalizeModelResponseV2({
      text: "legacy",
      toolIntents: [],
      provider: { name: "openai", model: "gpt-test", endpoint: "chat" },
    }).version,
    MODEL_RESPONSE_V2_VERSION,
  );
  assert.equal(
    parseModelResponseV2({
      version: MODEL_RESPONSE_V2_VERSION,
      text: "ok",
      toolIntents: [],
      provider: {
        name: "anthropic",
        model: "claude-test",
        endpoint: "messages",
      },
      terminal: {
        state: "completed",
        visibleOutputStarted: true,
        providerTerminalEvent: "message_stop",
      },
      validation: { state: "not_requested" },
    }).provider.endpoint,
    "messages",
  );
});

test("provider registry contains every shipped adapter once without claiming model capabilities", () => {
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
    assert.equal(
      entry.conformanceFixture.request.version,
      MODEL_REQUEST_VERSION,
    );
    assert.equal(typeof entry.factory, "function");
    assert.equal(entry.factory, expectedFactories[providerId]);
    assert.equal(entry.codecEnvelope.version, "provider_codec_envelope_v1");
    assert.equal("capabilityDeclaration" in entry, false);
    assert.ok(entry.codecEnvelope.requestEndpoints.length > 0);
    assert.ok(entry.codecEnvelope.responseEndpoints.length > 0);
    assert.ok(entry.codecEnvelope.streamingTerminalEvents.length > 0);
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

test("provider codec envelopes match the request each registered adapter transports", async () => {
  for (const entry of MODEL_PROVIDER_ADAPTERS_V1) {
    for (const mode of entry.conformanceFixture.reasoningProbe.modes) {
      let capturedBody: Record<string, unknown> | undefined;
      const fetchImpl: typeof fetch = async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({ error: { message: "conformance probe complete" } }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      };
      const gateway = createProviderProbeGateway(entry.providerId, fetchImpl);
      await assert.rejects(
        gateway.call({
          ...entry.conformanceFixture.request,
          reasoning: { mode },
        }),
      );
      assert.ok(
        capturedBody !== undefined,
        `${entry.providerId} did not dispatch its reasoning probe`,
      );
      assert.equal(
        Object.hasOwn(
          capturedBody,
          entry.conformanceFixture.reasoningProbe.requestBodyField,
        ),
        entry.codecEnvelope.reasoningModes.includes(mode),
        `${entry.providerId} ${mode} codec envelope disagrees with its transported request`,
      );
    }
  }
});

test("shared OpenAI-compatible transport preserves Lumi and RunPod identities", async () => {
  for (const providerId of ["lumi", "runpod"] as const) {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: `${providerId}-request`,
          model: `${providerId}-model`,
          choices: [{ message: { content: "ok", tool_calls: [] } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    const options = {
      fetchImpl,
      envConfig: {
        apiKey: "test-key",
        baseUrl: `https://${providerId}.example/v1`,
        model: `${providerId}-model`,
      },
      retryCount: 0,
    };
    const gateway =
      providerId === "lumi"
        ? createLumiModelGateway(options)
        : createRunPodModelGateway(options);
    const response = await gateway.call<ModelResponse>({ input: "hello" });
    assert.equal(response.provider.name, providerId);
    assert.equal(
      (response as { version?: string }).version,
      MODEL_RESPONSE_VERSION,
    );
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
      credentialReference: {
        source: "local-core",
        id: "provider.openai.default",
      },
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

function registrationAuthoringV2(): ModelRegistrationAuthoringV2 {
  const providerEvidence = [
    {
      source: "provider" as const,
      observedRevision: "provider-revision-1",
      observedAt: "2026-08-26T12:00:00.000Z",
      adapterRevision: "adapter-revision-1",
      credentialRevision: "credential-revision-1",
      retainedPayloadHash: hash(),
    },
  ];
  const qualificationEvidence = [
    {
      source: "qualification" as const,
      observedRevision: "provider-revision-1",
      observedAt: "2026-08-26T12:01:00.000Z",
      adapterRevision: "adapter-revision-1",
      credentialRevision: "credential-revision-1",
      qualificationRevision: "qualification-revision-1",
      retainedPayloadHash: hash("b"),
    },
  ];
  const declared = { state: "declared" as const, evidence: providerEvidence };
  const qualified = {
    state: "qualified" as const,
    evidence: qualificationEvidence,
  };
  return {
    version: MODEL_REGISTRATION_V2_VERSION,
    registrationId: "openai:gpt-test:provider-revision-1",
    providerId: "openai",
    modelId: "gpt-test",
    providerConfiguration: providerConfiguration(),
    route: {
      apiEndpoint: "https://api.openai.com/v1",
      endpointCodec: "openai_responses_v1",
      routing: {
        kind: "provider",
        policyId: "openai:primary",
        allowedEndpointIds: ["east", "west"],
        requireParameters: true,
      },
    },
    revision: "provider-revision-1",
    adapterRevision: "adapter-revision-1",
    credentialRevision: "credential-revision-1",
    providerEvidence,
    qualification: {
      state: "qualified",
      revision: "qualification-revision-1",
      checkedAt: "2026-08-26T12:01:00.000Z",
      probeHash: hash("c"),
    },
    capabilities: {
      jsonSyntax: declared,
      localSchemaValidation: declared,
      providerStrictSchema: qualified,
      nativeTools: qualified,
      requiredToolChoice: qualified,
      strictToolInputs: qualified,
      parallelToolCalls: declared,
      reasoning: { ...declared, modes: ["off", "provider_visible"] },
      continuation: { ...declared, kinds: [] },
      streaming: { ...declared, terminalEvents: ["response.completed"] },
      inputModalities: { text: declared, image: declared },
      limits: {
        context: { kind: "known", tokens: 128_000 },
        output: { kind: "known", tokens: 16_000 },
        evidence: providerEvidence,
      },
      cache: { ...declared, read: true, write: false, scope: "provider" },
    },
  };
}

function requestAuthoringV2() {
  return {
    version: MODEL_REQUEST_V2_VERSION,
    model: "gpt-test",
    input: "hello",
    responseFormat: "json" as const,
    responseSchema: {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
      additionalProperties: false,
    },
    tools: [toolSpec()],
    providerOptions: {
      openai: {
        endpoint: "responses" as const,
        toolChoice: "required",
        parallelToolCalls: false,
      },
    },
    requirements: {
      runtimeRole: "agent_action",
      output: {
        kind: "json_schema" as const,
        assurance: "local_schema_validation" as const,
        schemaName: "action",
      },
      tools: {
        choice: "required" as const,
        strictArguments: true,
        parallelism: "forbidden" as const,
      },
      reasoning: {
        mode: "off" as const,
        continuationKinds: [],
      },
      streaming: { required: false, terminalBehavior: "not_required" as const },
      inputModalities: ["text" as const],
      endpoint: "responses" as const,
    },
  };
}

function toolSpec() {
  return {
    name: "lookup",
    description: "Look up a value.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  };
}

function hash(character = "a"): string {
  return `sha256:${character.repeat(64)}`;
}

function createProviderProbeGateway(
  providerId: (typeof MODEL_PROVIDER_IDENTITIES_V1)[number],
  fetchImpl: typeof fetch,
) {
  const openAiCompatible = {
    fetchImpl,
    retryCount: 0,
    envConfig: {
      apiKey: "conformance-key",
      baseUrl: `https://${providerId}.example`,
      model: `${providerId}-conformance-fixture`,
    },
  };
  switch (providerId) {
    case "openrouter":
      return createOpenRouterModelGatewayFromEnv(openAiCompatible);
    case "openai":
      return createOpenAiModelGatewayFromEnv(openAiCompatible);
    case "anthropic":
      return createAnthropicModelGatewayFromEnv({
        ...openAiCompatible,
        envConfig: {
          ...openAiCompatible.envConfig,
          version: "2023-06-01",
        },
      });
    case "ollama":
      return createOllamaModelGatewayFromEnv(openAiCompatible);
    case "lmstudio":
      return createLmStudioModelGatewayFromEnv(openAiCompatible);
    case "lumi":
      return createLumiModelGateway(openAiCompatible);
    case "runpod":
      return createRunPodModelGateway(openAiCompatible);
  }
}
