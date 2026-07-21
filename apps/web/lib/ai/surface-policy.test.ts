import assert from "node:assert/strict";
import { getKnowledgeEmbeddingRuntime } from "../knowledge/documents/embed";
import {
  getAISurfacePolicy,
  getDirectRuntimeConfig,
  getGatewayResolutionFailureMessage,
  isPlaceholderRuntimeApiKey,
} from "./surface-policy";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


function toEnv(values: Record<string, string>) {
  return values as unknown as NodeJS.ProcessEnv;
}

contractTest("web.hermetic", "gateway-governed and direct-runtime surfaces stay explicit", () => {
  assert.equal(getAISurfacePolicy("chat"), "gateway-required");
  assert.equal(getAISurfacePolicy("artifact"), "gateway-required");
  assert.equal(getAISurfacePolicy("embedding"), "runtime-direct");
  assert.equal(getAISurfacePolicy("ocr"), "runtime-direct");
});

contractTest("web.hermetic", "runtime-direct config treats placeholder API keys as fallback mode", () => {
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

contractTest("web.hermetic", "embedding config safely inherits the official OpenRouter agent runtime", () => {
  const config = getDirectRuntimeConfig(
    "embedding",
    toEnv({
      AI_PROVIDER: "openrouter",
      AI_AGENT_BASE_URL: "https://openrouter.ai/api/v1",
      AI_AGENT_API_KEY: "agent-key",
    })
  );

  assert.equal(config.provider, "openrouter");
  assert.equal(config.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(config.model, "openai/text-embedding-3-small");
  assert.equal(config.apiKey, "agent-key");
  assert.equal(config.mode, "live");
  assert.equal(
    getKnowledgeEmbeddingRuntime(
      toEnv({
        AI_PROVIDER: "openrouter",
        AI_AGENT_BASE_URL: "https://openrouter.ai/api/v1",
        AI_AGENT_API_KEY: "agent-key",
      })
    ).retrievalStrategy,
    "semantic-first"
  );
});

contractTest("web.hermetic", "embedding config reuses the standard OpenRouter gateway credential", () => {
  const config = getDirectRuntimeConfig(
    "embedding",
    toEnv({
      OPENROUTER_API_KEY: "gateway-key",
    })
  );

  assert.equal(config.provider, "openrouter");
  assert.equal(config.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(config.model, "openai/text-embedding-3-small");
  assert.equal(config.apiKey, "gateway-key");
  assert.equal(config.mode, "live");
});

contractTest("web.hermetic", "dedicated embedding configuration retains precedence over OpenRouter inheritance", () => {
  const dedicatedEmbedding = getDirectRuntimeConfig(
    "embedding",
    toEnv({
      AI_PROVIDER: "openrouter",
      AI_AGENT_BASE_URL: "https://openrouter.ai/api/v1",
      AI_AGENT_API_KEY: "agent-key",
      AI_EMBEDDING_API_KEY: "dedicated-key",
    })
  );
  assert.equal(dedicatedEmbedding.provider, "openai");
  assert.equal(dedicatedEmbedding.baseURL, "https://api.openai.com/v1");
  assert.equal(dedicatedEmbedding.model, "text-embedding-3-small");
  assert.equal(dedicatedEmbedding.apiKey, "dedicated-key");
});

contractTest("web.hermetic", "embedding runtime refuses to send an OpenRouter key to another endpoint", () => {
  const config = getDirectRuntimeConfig(
    "embedding",
    toEnv({
      AI_PROVIDER: "openrouter",
      AI_AGENT_BASE_URL: "https://proxy.example.test/v1",
      AI_AGENT_API_KEY: "agent-key",
    })
  );
  assert.equal(config.provider, "openai");
  assert.equal(config.apiKey, null);
  assert.equal(config.mode, "fallback");
});

contractTest("web.hermetic", "embedding runtime derives semantic and lexical retrieval strategies", () => {
  const openrouterEmbedding = getKnowledgeEmbeddingRuntime(
    toEnv({
      AI_EMBEDDING_BASE_URL: "https://openrouter.ai/api/v1",
      AI_EMBEDDING_API_KEY: "embedding-key",
    })
  );
  assert.equal(openrouterEmbedding.provider, "openrouter");
  assert.equal(openrouterEmbedding.mode, "live");
  assert.equal(openrouterEmbedding.retrievalStrategy, "semantic-first");
  assert.equal(openrouterEmbedding.model, "openai/text-embedding-3-small");

  const fallbackEmbedding = getKnowledgeEmbeddingRuntime(
    toEnv({
      AI_EMBEDDING_API_KEY: "sk_your_provider_key",
    })
  );
  assert.equal(fallbackEmbedding.mode, "fallback");
  assert.equal(fallbackEmbedding.retrievalStrategy, "lexical");
});

contractTest("web.hermetic", "gateway resolution errors are explicit about the surface and model", () => {
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
