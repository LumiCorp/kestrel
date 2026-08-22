import test from "node:test";
import assert from "node:assert/strict";
import { fetchOpenRouterModelDetailsWithCredentials } from "./openrouter-model-resolution";
import { GatewayModelProviderResolutionError } from "./gateway-lifecycle-error";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

test("OpenRouter detail resolution uses the exact route and bearer credential", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const details = await fetchOpenRouterModelDetailsWithCredentials({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "secret",
    rawModelId: "z-ai/glm-5.2:free",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return response(200, {
        data: {
          id: "z-ai/glm-5.2:free",
          canonical_slug: "z-ai/glm-5.2-20260616",
          context_length: 256_000,
          top_provider: { max_completion_tokens: 256_000 },
        },
      });
    },
  });
  assert.equal(request?.url, "https://openrouter.ai/api/v1/model/z-ai/glm-5.2%3Afree");
  assert.deepEqual(request?.init?.headers, { Authorization: "Bearer secret" });
  assert.equal(details.id, "z-ai/glm-5.2:free");
});

test("OpenRouter detail resolution classifies auth, transient, and exact-ID failures", async () => {
  await assert.rejects(
    fetchOpenRouterModelDetailsWithCredentials({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "secret",
      rawModelId: "qwen/qwen3.8-27b",
      fetchImpl: async () => response(401, {}),
    }),
    (error: unknown) =>
      error instanceof GatewayModelProviderResolutionError &&
      error.status === 401 &&
      error.retryable === false,
  );
  await assert.rejects(
    fetchOpenRouterModelDetailsWithCredentials({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "secret",
      rawModelId: "qwen/qwen3.8-27b",
      fetchImpl: async () => response(429, {}),
    }),
    (error: unknown) =>
      error instanceof GatewayModelProviderResolutionError &&
      error.status === 503 &&
      error.retryable === true,
  );
  await assert.rejects(
    fetchOpenRouterModelDetailsWithCredentials({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "secret",
      rawModelId: "qwen/alias",
      fetchImpl: async () => response(200, { data: { id: "qwen/other" } }),
    }),
    /Approve the exact returned model ID/u,
  );
});

test("a stalled OpenRouter response body is a retryable timeout", async () => {
  await assert.rejects(
    fetchOpenRouterModelDetailsWithCredentials({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "secret",
      rawModelId: "qwen/qwen3.8-27b",
      timeoutMs: 5,
      fetchImpl: async (_url, init) => ({
        ok: true,
        status: 200,
        json: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (init?.signal?.aborted) throw new Error("aborted");
          return {};
        },
      } as Response),
    }),
    (error: unknown) =>
      error instanceof GatewayModelProviderResolutionError &&
      error.status === 503 &&
      error.retryable === true,
  );
});
