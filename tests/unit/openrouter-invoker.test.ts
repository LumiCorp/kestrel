import test from "node:test";
import assert from "node:assert/strict";

import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";

import { createOpenRouterInvoker } from "../../models/index.js";

const BASE_ENV = {
  apiKey: "key",
  model: "openai/gpt-5.2-chat",
  baseUrl: "https://openrouter.ai",
};

function decisionRequest(): ModelRequest {
  return {
    model: "openai/gpt-5.2-chat",
    input: { goal: "test" },
    responseFormat: "json",
    responseSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
      },
      required: ["ok"],
    },
  };
}

test("OpenRouter invoker fails fast on constrained schema rejection", async () => {
  let calls = 0;
  const invoker = createOpenRouterInvoker({
    env: BASE_ENV,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Provider returned error",
              metadata: {
                raw: JSON.stringify({
                  error: {
                    message:
                      "Invalid schema for response_format 'kestrel_response': In context=('properties', 'plan')",
                  },
                }),
              },
            },
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          model: "openai/gpt-5.2-chat",
          choices: [
            {
              message: {
                content: JSON.stringify({ ok: true }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  await assert.rejects(
    async () => invoker<{ ok: boolean }>(decisionRequest()),
    (error: unknown) => {
      const cast = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "MODEL_PROVIDER_SCHEMA");
      assert.equal(cast.details?.category, "provider_schema");
      return true;
    },
  );

  assert.equal(calls, 1);
});

test("OpenRouter invoker reports text fallback parse separately from schema request", async () => {
  let calls = 0;
  const invoker = createOpenRouterInvoker({
    env: BASE_ENV,
    fetchImpl: async (_url, init) => {
      calls += 1;
      const parsedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const responseFormat = parsedBody.response_format as Record<string, unknown>;
      assert.equal(responseFormat?.type, "json_schema");
      return new Response(
        JSON.stringify({
          model: "openai/gpt-5.2-chat",
          choices: [
            {
              message: {
                content: JSON.stringify({ ok: true }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const response = await invoker<{ ok: boolean }>(decisionRequest());

  assert.equal(calls, 1);
  assert.equal(response.output?.ok, true);
  assert.deepEqual(response.rawResponse, {
    model: "openai/gpt-5.2-chat",
    choices: [
      {
        message: {
          content: JSON.stringify({ ok: true }),
        },
      },
    ],
  });
  assert.equal(response.provider.structuredOutput?.mode, "constrained");
  assert.equal(response.provider.structuredOutput?.outcome, "text_fallback_parsed");
  assert.equal(response.provider.structuredOutput?.source, "text_fallback");
  assert.equal(response.provider.structuredOutput?.schemaRequested, true);
  assert.equal(response.provider.structuredOutput?.schemaName, "kestrel_response");
  assert.equal(
    typeof response.provider.structuredOutput?.compilerDiagnostics?.requiredPropertyExpansions,
    "number",
  );
});

test("OpenRouter invoker rejects error payloads returned with successful HTTP status", async () => {
  const invoker = createOpenRouterInvoker({
    env: BASE_ENV,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Provider returned error",
            code: 400,
          },
        }),
        { status: 200 },
      ),
  });

  await assert.rejects(
    async () => invoker<{ ok: boolean }>(decisionRequest()),
    (error: unknown) => {
      const cast = error as { code?: string; message?: string };
      assert.equal(cast.code, "MODEL_BAD_RESPONSE");
      assert.match(cast.message ?? "", /Provider returned error/u);
      return true;
    },
  );
});

test("OpenRouter invoker reports provider parsed structured output", async () => {
  const invoker = createOpenRouterInvoker({
    env: BASE_ENV,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "openai/gpt-5.2-chat",
          choices: [
            {
              message: {
                parsed: { ok: true },
                content: JSON.stringify({ ok: false }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
  });

  const response = await invoker<{ ok: boolean }>(decisionRequest());

  assert.equal(response.output?.ok, true);
  assert.equal(response.provider.structuredOutput?.outcome, "provider_parsed");
  assert.equal(response.provider.structuredOutput?.source, "provider");
});

test("OpenRouter invoker reports structured parse failure without success telemetry", async () => {
  const invoker = createOpenRouterInvoker({
    env: BASE_ENV,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "openai/gpt-5.2-chat",
          choices: [
            {
              message: {
                content: "{\"ok\":",
              },
            },
          ],
        }),
        { status: 200 },
      ),
  });

  const response = await invoker<{ ok: boolean }>(decisionRequest());

  assert.equal(response.output, undefined);
  assert.equal(response.text, "{\"ok\":");
  assert.equal(response.provider.structuredOutput?.outcome, "parse_failed");
  assert.equal(response.provider.structuredOutput?.source, "none");
});
