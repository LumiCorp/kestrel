import test from "node:test";
import assert from "node:assert/strict";

import type { ModelResponse, ModelToolSpec } from "../../src/kestrel/contracts/model-io.js";

import {
  createAnthropicModelGatewayFromEnv,
  createDefaultToolGateway,
  createLmStudioModelGatewayFromEnv,
  createOpenAiModelGatewayFromEnv,
  createOllamaModelGatewayFromEnv,
  createOpenRouterModelGatewayFromEnv,
} from "../../src/index.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

const REQUIRED_TOOL: ModelToolSpec = {
  name: "kestrel_finalize",
  description: "Finish the run.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["goal_satisfied"] },
      message: { type: "string", minLength: 1 },
    },
    required: ["status", "message"],
  },
};

const OPTIONAL_TOOL: ModelToolSpec = {
  name: "weather.current",
  description: "Read current weather.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      city: { type: "string" },
      latitude: { type: "number" },
    },
  },
};

const UNION_TOOL: ModelToolSpec = {
  name: "exec_command",
  description: "Run or continue one command.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string" },
      sessionId: { type: "string" },
    },
    oneOf: [
      { required: ["command"] },
      { required: ["sessionId"] },
    ],
  },
};

test("createOpenRouterModelGatewayFromEnv validates required OPENROUTER_API_KEY", () => {
  assert.throws(
    () =>
      createOpenRouterModelGatewayFromEnv({
        env: {},
      }),
    /OPENROUTER_API_KEY is required/,
  );
});

test("createOpenRouterModelGatewayFromEnv calls chat endpoint by default", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const gateway = createOpenRouterModelGatewayFromEnv({
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "openai/gpt-5.2-chat",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });

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
        {
          status: 200,
          headers: {
            "x-request-id": "req_chat_1",
          },
        },
      );
    },
    retryCount: 0,
  });

  const response = await gateway.call<ModelResponse<{ ok: boolean }>>({
    input: "hello",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.endsWith("/api/v1/chat/completions"), true);
  assert.equal(requests[0]?.body.model, "openai/gpt-5.2-chat");
  assert.equal(response.output?.ok, true);
  assert.equal(response.provider.endpoint, "chat");
  assert.equal(response.provider.requestId, "req_chat_1");
});

test("createOpenRouterModelGatewayFromEnv preserves required tool choice", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const gateway = createOpenRouterModelGatewayFromEnv({
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "openai/gpt-5.2-chat",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });

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
    retryCount: 0,
  });

  await gateway.call<ModelResponse<{ ok: boolean }>>({
    input: "hello",
    tools: [REQUIRED_TOOL],
    providerOptions: {
      openrouter: {
        toolChoice: "required",
      },
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.endsWith("/api/v1/chat/completions"), true);
  assert.equal(requests[0]?.body.tool_choice, "required");
  assert.equal(requests[0]?.body.parallel_tool_calls, true);
  assert.equal(Array.isArray(requests[0]?.body.tools), true);
});

test("createOpenRouterModelGatewayFromEnv supports responses endpoint override", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const gateway = createOpenRouterModelGatewayFromEnv({
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "openai/gpt-5.2-chat",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });

      return new Response(
        JSON.stringify({
          model: "openai/gpt-5.2-chat",
          output_text: JSON.stringify({ ok: true }),
          output: [],
        }),
        { status: 200 },
      );
    },
    retryCount: 0,
  });

  const response = await gateway.call<ModelResponse<{ ok: boolean }>>({
    input: "hello",
    providerOptions: {
      openrouter: {
        endpoint: "responses",
      },
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.endsWith("/api/v1/responses"), true);
  assert.equal(response.provider.endpoint, "responses");
  assert.equal(response.output?.ok, true);
});

test("createOpenAiModelGatewayFromEnv validates required OPENAI_API_KEY", () => {
  assert.throws(
    () =>
      createOpenAiModelGatewayFromEnv({
        env: {},
      }),
    /OPENAI_API_KEY is required/,
  );
});

test("createOllamaModelGatewayFromEnv calls the local OpenAI-compatible endpoint without auth", async () => {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];

  const gateway = createOllamaModelGatewayFromEnv({
    env: {
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      OLLAMA_MODEL: "llama3.2:3b",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });

      return new Response(
        JSON.stringify({
          model: "llama3.2:3b",
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
    retryCount: 0,
  });

  const response = await gateway.call<ModelResponse<{ ok: boolean }>>({
    input: "hello",
  });

  assert.equal(requests[0]?.url.endsWith("/v1/chat/completions"), true);
  assert.equal(requests[0]?.headers.has("authorization"), false);
  assert.equal(requests[0]?.body.model, "llama3.2:3b");
  assert.equal(response.provider.name, "ollama");
  assert.equal(response.output?.ok, true);
});

test("createOllamaModelGatewayFromEnv falls back to json_object for schema-constrained JSON requests", async () => {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];

  const gateway = createOllamaModelGatewayFromEnv({
    env: {
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      OLLAMA_MODEL: "llama3.2:3b",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });

      return new Response(
        JSON.stringify({
          model: "llama3.2:3b",
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
    retryCount: 0,
  });

  const response = await gateway.call<ModelResponse<{ ok: boolean }>>({
    input: "hello",
    responseFormat: "json",
    responseSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
      },
      required: ["ok"],
    },
    providerOptions: {
      openai: {
        responseSchemaName: "kestrel_test_schema",
      },
    },
  });

  assert.equal(requests[0]?.url.endsWith("/v1/chat/completions"), true);
  assert.deepEqual(requests[0]?.body.response_format, {
    type: "json_object",
  });
  assert.equal(response.provider.name, "ollama");
  assert.equal(response.provider.structuredOutput?.mode, "json_object");
  assert.equal(response.provider.structuredOutput?.schemaName, "kestrel_test_schema");
  assert.equal(response.output?.ok, true);
});

test("createLmStudioModelGatewayFromEnv uses the LM Studio default local endpoint", async () => {
  const requests: string[] = [];

  const gateway = createLmStudioModelGatewayFromEnv({
    env: {
      LMSTUDIO_MODEL: "local-model",
    },
    fetchImpl: async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          model: "local-model",
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
    retryCount: 0,
  });

  const response = await gateway.call<ModelResponse<{ ok: boolean }>>({
    input: "hello",
  });

  assert.equal(requests[0], "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(response.provider.name, "lmstudio");
  assert.equal(response.output?.ok, true);
});

test("createOpenAiModelGatewayFromEnv calls chat completions with structured output", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const gateway = createOpenAiModelGatewayFromEnv({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "gpt-4.1-mini",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });

      return new Response(
        JSON.stringify({
          model: "gpt-4.1-mini",
          choices: [
            {
              message: {
                content: JSON.stringify({ ok: true }),
              },
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 3,
            total_tokens: 8,
          },
        }),
        {
          status: 200,
          headers: {
            "x-request-id": "req_openai_1",
          },
        },
      );
    },
    retryCount: 0,
  });

  const response = await gateway.call<ModelResponse<{ ok: boolean }>>({
    input: "hello",
    responseFormat: "json",
    responseSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        note: { type: "string" },
      },
      required: ["ok"],
    },
    metadata: {
      runtimeBudgetRemainingMs: 1234,
      phase: "route",
      nested: { ok: true },
    },
    providerOptions: {
      openai: {
        endpoint: "chat",
      },
      openrouter: {
        toolChoice: "none",
        responseSchemaName: "kestrel_test_schema",
      },
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.endsWith("/v1/chat/completions"), true);
  assert.deepEqual(requests[0]?.body.response_format, {
    type: "json_schema",
    json_schema: {
      name: "kestrel_test_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean" },
            note: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
          },
          required: ["ok", "note"],
        },
        strict: true,
      },
  });
  assert.equal(requests[0]?.body.metadata, undefined);
  assert.equal(requests[0]?.body.tool_choice, undefined);
  assert.equal(response.provider.name, "openai");
  assert.equal(response.provider.endpoint, "chat");
  assert.equal(response.provider.requestId, "req_openai_1");
  assert.equal(response.output?.ok, true);
});

test("createOpenAiModelGatewayFromEnv preserves required tool choice", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const gateway = createOpenAiModelGatewayFromEnv({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "gpt-4.1-mini",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });

      return new Response(
        JSON.stringify({
          model: "gpt-4.1-mini",
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
    retryCount: 0,
  });

  await gateway.call<ModelResponse<{ ok: boolean }>>({
    input: "hello",
    tools: [REQUIRED_TOOL],
    providerOptions: {
      openai: {
        endpoint: "chat",
        toolChoice: "required",
      },
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.endsWith("/v1/chat/completions"), true);
  assert.equal(requests[0]?.body.tool_choice, "required");
  assert.equal(requests[0]?.body.parallel_tool_calls, true);
  assert.equal(Array.isArray(requests[0]?.body.tools), true);
  const mappedTools = requests[0]?.body.tools as
    | Array<{ function?: { strict?: boolean } }>
    | undefined;
  assert.equal(mappedTools?.[0]?.function?.strict, true);
});

test("createOpenAiModelGatewayFromEnv does not claim strict mode for optional tool schemas", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const gateway = createOpenAiModelGatewayFromEnv({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "gpt-5-mini",
    },
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({
          model: "gpt-5-mini",
          choices: [{ message: { content: "done" } }],
        }),
        { status: 200 }
      );
    },
    retryCount: 0,
  });

  await gateway.call({
    input: "hello",
    tools: [OPTIONAL_TOOL, UNION_TOOL],
    providerOptions: {
      openai: {
        endpoint: "chat",
      },
    },
  });

  const tools = requestBody?.tools as
    | Array<{
        function?: {
          parameters?: Record<string, unknown>;
          strict?: boolean;
        };
      }>
    | undefined;
  assert.equal(tools?.[0]?.function?.strict, undefined);
  assert.equal(tools?.[1]?.function?.strict, undefined);
  assert.equal(tools?.[1]?.function?.parameters?.type, "object");
  assert.equal(tools?.[1]?.function?.parameters?.oneOf, undefined);
});

test("createAnthropicModelGatewayFromEnv validates required ANTHROPIC_API_KEY", () => {
  assert.throws(
    () =>
      createAnthropicModelGatewayFromEnv({
        env: {},
      }),
    /ANTHROPIC_API_KEY is required/,
  );
});

test("createAnthropicModelGatewayFromEnv maps required tool choice to any", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const gateway = createAnthropicModelGatewayFromEnv({
    env: {
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_MODEL: "claude-3-5-haiku-latest",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });

      return new Response(
        JSON.stringify({
          model: "claude-3-5-haiku-latest",
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true }),
            },
          ],
          usage: {
            input_tokens: 9,
            output_tokens: 4,
          },
        }),
        { status: 200 },
      );
    },
    retryCount: 0,
  });

  await gateway.call<ModelResponse<{ ok: boolean }>>({
    input: "hello",
    tools: [REQUIRED_TOOL],
    reasoning: { mode: "provider_visible" },
    providerOptions: {
      anthropic: {
        toolChoice: "required",
      },
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.endsWith("/v1/messages"), true);
  assert.deepEqual(requests[0]?.body.tool_choice, { type: "any" });
  assert.equal(requests[0]?.body.thinking, undefined);
  assert.equal(Array.isArray(requests[0]?.body.tools), true);
});

test("createAnthropicModelGatewayFromEnv calls messages API with structured output tool", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const gateway = createAnthropicModelGatewayFromEnv({
    env: {
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_MODEL: "claude-3-5-haiku-latest",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });

      return new Response(
        JSON.stringify({
          model: "claude-3-5-haiku-latest",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "kestrel_test_schema",
              input: {
                ok: true,
              },
            },
          ],
          usage: {
            input_tokens: 9,
            output_tokens: 4,
          },
        }),
        {
          status: 200,
          headers: {
            "request-id": "req_anthropic_1",
          },
        },
      );
    },
    retryCount: 0,
  });

  const response = await gateway.call<ModelResponse<{ ok: boolean }>>({
    input: "hello",
    responseFormat: "json",
    responseSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
      },
      required: ["ok"],
    },
    providerOptions: {
      anthropic: {
        responseSchemaName: "kestrel_test_schema",
      },
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.endsWith("/v1/messages"), true);
  assert.equal(Array.isArray(requests[0]?.body.tools), true);
  assert.equal(response.provider.name, "anthropic");
  assert.equal(response.provider.requestId, "req_anthropic_1");
  assert.equal(response.output?.ok, true);
});

test("createDefaultToolGateway resolves runtime dependencies for effect_result_lookup and FinalizeAnswer", async () => {
  const store = new InMemorySessionStore();
  await store.saveEffectResult("run_1", "session_1", {
    idempotencyKey: "key_1",
    status: "DONE",
    output: {
      ok: true,
    },
    timestamp: new Date().toISOString(),
  });

  const finalized: unknown[] = [];
  const gateway = createDefaultToolGateway({
    allowlist: ["effect_result_lookup", "FinalizeAnswer"],
    context: {
      store,
      onFinalize: (payload) => {
        finalized.push(payload);
        return { accepted: true };
      },
    },
  });

  const lookedUp = await gateway.call("effect_result_lookup", {
    idempotencyKey: "key_1",
  });

  const finalizeResult = await gateway.call("FinalizeAnswer", {
    answer: "done",
  });

  assert.deepEqual((lookedUp.auditRecord.output as { output?: { ok?: boolean } }).output, { ok: true });
  assert.deepEqual(finalizeResult.auditRecord.output, { accepted: true });
  assert.equal(finalized.length, 1);
});
