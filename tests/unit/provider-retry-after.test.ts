import assert from "node:assert/strict";
import test from "node:test";

import { createAnthropicInvoker } from "../../models/anthropic/AnthropicInvoker.js";
import { createOpenAiInvoker } from "../../models/openai/OpenAiInvoker.js";

test("OpenAI invoker carries normalized Retry-After without retaining the raw header", async () => {
  const invoker = createOpenAiInvoker({
    env: {
      providerName: "openai",
      providerLabel: "OpenAI",
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://api.openai.test",
    },
    fetchImpl: (async () => new Response(
      JSON.stringify({ error: { message: "slow down" } }),
      { status: 429, headers: { "retry-after": "2.5" } },
    )) as typeof fetch,
  });

  await assert.rejects(
    () => invoker({ input: "test" }),
    (error: unknown) => {
      const failure = error as { code?: unknown; retryAfterMs?: unknown };
      assert.equal(failure.code, "MODEL_RATE_LIMITED");
      assert.equal(failure.retryAfterMs, 2500);
      return true;
    },
  );
});

test("Anthropic invoker carries normalized Retry-After", async () => {
  const invoker = createAnthropicInvoker({
    env: {
      apiKey: "test-key",
      model: "claude-test",
      baseUrl: "https://api.anthropic.test",
      version: "2023-06-01",
    },
    fetchImpl: (async () => new Response(
      JSON.stringify({ error: { message: "timeout" } }),
      { status: 408, headers: { "retry-after": "1.25" } },
    )) as typeof fetch,
  });

  await assert.rejects(
    () => invoker({ input: "test" }),
    (error: unknown) => {
      const failure = error as { code?: unknown; retryAfterMs?: unknown };
      assert.equal(failure.code, "MODEL_TIMEOUT");
      assert.equal(failure.retryAfterMs, 1250);
      return true;
    },
  );
});
