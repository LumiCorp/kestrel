import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunPodServerlessBaseUrl,
  GATEWAY_PROVIDERS,
  getGatewayLanguageProtocol,
  getProviderSupportedModalities,
  isGatewayModelDefault,
  isKestrelRuntimeLanguageProvider,
  isRunPodServerlessBaseUrl,
  normalizeGatewayModelMetadata,
  normalizeOpenAICompatibleBaseUrl,
  selectGatewayModelSelection,
  selectPreferredGatewayModelId,
} from "./gateway-utils";

test("Lumi is registered with OpenAI-style default modalities", () => {
  assert.ok(GATEWAY_PROVIDERS.includes("lumi"));
  assert.deepEqual(getProviderSupportedModalities("lumi"), [
    "language",
    "image",
    "speech",
    "embedding",
  ]);
});

test("RunPod is a language provider with an exact serverless endpoint contract", () => {
  assert.ok(GATEWAY_PROVIDERS.includes("runpod"));
  assert.deepEqual(getProviderSupportedModalities("runpod"), ["language"]);
  assert.equal(
    buildRunPodServerlessBaseUrl("endpoint_123"),
    "https://api.runpod.ai/v2/endpoint_123/openai/v1"
  );
  assert.equal(
    isRunPodServerlessBaseUrl(
      "https://api.runpod.ai/v2/endpoint_123/openai/v1"
    ),
    true
  );
  assert.equal(
    isRunPodServerlessBaseUrl(
      "https://internal.example/v2/endpoint_123/openai/v1"
    ),
    false
  );
  assert.throws(() => buildRunPodServerlessBaseUrl("../admin"));
});

test("an explicit unavailable model never falls back to the gateway default", () => {
  const models = [
    {
      id: "approved-default",
      alias: "default",
      rawModelId: "gpt-5.4",
      gatewayProvider: "openai" as const,
      isDefault: true,
    },
  ];
  assert.equal(
    selectGatewayModelSelection(models, "unapproved-or-missing"),
    null
  );
  assert.equal(
    selectGatewayModelSelection(models, "approved-default")?.rawModelId,
    "gpt-5.4"
  );
});

test("external Kestrel chat runtime excludes unsupported gateway providers", () => {
  assert.equal(isKestrelRuntimeLanguageProvider("openai"), true);
  assert.equal(isKestrelRuntimeLanguageProvider("anthropic"), true);
  assert.equal(isKestrelRuntimeLanguageProvider("ollama"), true);
  assert.equal(isKestrelRuntimeLanguageProvider("openrouter"), true);
  assert.equal(isKestrelRuntimeLanguageProvider("runpod"), true);
  assert.equal(isKestrelRuntimeLanguageProvider("lumi"), true);
  assert.equal(isKestrelRuntimeLanguageProvider("replicate"), false);
});

test("Environment defaults override but do not erase the platform default", () => {
  assert.equal(
    isGatewayModelDefault({
      modelId: "platform-default",
      modelIsDefault: true,
    }),
    true
  );
  assert.equal(
    isGatewayModelDefault({
      environmentDefaultModelId: "environment-default",
      modelId: "platform-default",
      modelIsDefault: true,
    }),
    false
  );
  assert.equal(
    isGatewayModelDefault({
      environmentDefaultModelId: "environment-default",
      modelId: "environment-default",
      modelIsDefault: false,
    }),
    true
  );
});

test("OpenAI-compatible base URLs normalize to /v1 only when needed", () => {
  assert.equal(
    normalizeOpenAICompatibleBaseUrl("https://api.kestrelagents.dev"),
    "https://api.kestrelagents.dev/v1"
  );
  assert.equal(
    normalizeOpenAICompatibleBaseUrl("https://api.kestrelagents.dev/v1"),
    "https://api.kestrelagents.dev/v1"
  );
  assert.equal(
    normalizeOpenAICompatibleBaseUrl("https://api.kestrelagents.dev/proxy"),
    "https://api.kestrelagents.dev/proxy/v1"
  );
});

test("Lumi language models default to OpenAI protocol unless overridden", () => {
  assert.equal(
    getGatewayLanguageProtocol({
      gatewayProvider: "lumi",
      modality: "language",
      metadata: null,
    }),
    "openai"
  );

  assert.equal(
    getGatewayLanguageProtocol({
      gatewayProvider: "lumi",
      modality: "language",
      metadata: { protocol: "anthropic" },
    }),
    "anthropic"
  );

  assert.equal(
    getGatewayLanguageProtocol({
      gatewayProvider: "lumi",
      modality: "image",
      metadata: { protocol: "anthropic" },
    }),
    "openai"
  );
});

test("Lumi sync metadata preserves model metadata and defaults protocol", () => {
  assert.deepEqual(
    normalizeGatewayModelMetadata({
      gatewayProvider: "lumi",
      modality: "language",
      metadata: { tier: "prod" },
    }),
    { protocol: "openai", tier: "prod" }
  );

  assert.deepEqual(
    normalizeGatewayModelMetadata({
      gatewayProvider: "lumi",
      modality: "language",
      metadata: { protocol: "anthropic", tier: "prod" },
    }),
    { protocol: "anthropic", tier: "prod" }
  );

  assert.deepEqual(
    normalizeGatewayModelMetadata({
      gatewayProvider: "lumi",
      modality: "embedding",
      metadata: { tier: "prod" },
    }),
    { tier: "prod" }
  );
});

test("approved model preference uses explicit selection, then organization default", () => {
  const models = [
    { id: "org-default", isDefault: false },
    { id: "gateway-default", isDefault: true },
  ];

  assert.equal(
    selectPreferredGatewayModelId(models, "user-selection", "org-default"),
    "org-default"
  );
  assert.equal(
    selectPreferredGatewayModelId(models, "gateway-default", "org-default"),
    "gateway-default"
  );
  assert.equal(
    selectPreferredGatewayModelId(models, null, "missing-model"),
    "gateway-default"
  );
});
