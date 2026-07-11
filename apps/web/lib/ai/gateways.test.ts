import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_PROVIDERS,
  getGatewayLanguageProtocol,
  getProviderSupportedModalities,
  normalizeGatewayModelMetadata,
  normalizeOpenAICompatibleBaseUrl,
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
