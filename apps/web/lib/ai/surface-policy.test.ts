import assert from "node:assert/strict";
import test from "node:test";
import { getKnowledgeEmbeddingRuntime } from "../knowledge/documents/embed";
import {
  getAISurfacePolicy,
  getDirectRuntimeConfig,
  getGatewayResolutionFailureMessage,
  isPlaceholderRuntimeApiKey,
} from "./surface-policy";

function toEnv(values: Record<string, string>) {
  return values as unknown as NodeJS.ProcessEnv;
}

test("gateway-governed and direct-runtime surfaces stay explicit", () => {
  assert.equal(getAISurfacePolicy("chat"), "gateway-required");
  assert.equal(getAISurfacePolicy("artifact"), "gateway-required");
  assert.equal(getAISurfacePolicy("embedding"), "runtime-direct");
  assert.equal(getAISurfacePolicy("ocr"), "runtime-direct");
});

test("runtime-direct config treats placeholder API keys as fallback mode", () => {
  const config = getDirectRuntimeConfig(
    "runtime-direct",
    toEnv({
      AI_AGENT_API_KEY: "sk_your_provider_key",
      AI_AGENT_MODEL: "gpt-5-mini",
    })
  );

  assert.equal(config.mode, "fallback");
  assert.equal(config.apiKey, null);
  assert.equal(config.usesPlaceholderKey, true);
  assert.equal(isPlaceholderRuntimeApiKey("sk_your_provider_key"), true);
});

test("embedding config does not inherit unrelated generic runtime provider defaults", () => {
  const config = getDirectRuntimeConfig(
    "embedding",
    toEnv({
      AI_PROVIDER: "openrouter",
      AI_AGENT_BASE_URL: "https://openrouter.ai/api/v1",
      AI_AGENT_API_KEY: "agent-key",
    })
  );

  assert.equal(config.provider, "openai");
  assert.equal(config.baseURL, "https://api.openai.com/v1");
  assert.equal(config.model, "text-embedding-3-small");
});

test("embedding runtime derives lexical fallback for openrouter and fallback mode", () => {
  const openrouterEmbedding = getKnowledgeEmbeddingRuntime(
    toEnv({
      AI_EMBEDDING_BASE_URL: "https://openrouter.ai/api/v1",
      AI_EMBEDDING_API_KEY: "embedding-key",
    })
  );
  assert.equal(openrouterEmbedding.provider, "openrouter");
  assert.equal(openrouterEmbedding.mode, "live");
  assert.equal(openrouterEmbedding.retrievalStrategy, "lexical");

  const fallbackEmbedding = getKnowledgeEmbeddingRuntime(
    toEnv({
      AI_EMBEDDING_API_KEY: "sk_your_provider_key",
    })
  );
  assert.equal(fallbackEmbedding.mode, "fallback");
  assert.equal(fallbackEmbedding.retrievalStrategy, "lexical");
});

test("gateway resolution errors are explicit about the surface and model", () => {
  assert.equal(
    getGatewayResolutionFailureMessage({
      surface: "chat",
      modelId: "missing-model",
    }),
    'Model "missing-model" is not an approved gateway model for the chat surface.'
  );

  assert.equal(
    getGatewayResolutionFailureMessage({
      surface: "artifact",
      modelId: null,
    }),
    "No approved gateway model is configured for the artifact surface."
  );
});
