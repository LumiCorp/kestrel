import assert from "node:assert/strict";

import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";

import {
  buildOpenRouterHttpRequest,
  mapOpenRouterResponse,
} from "../../models/index.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "OpenRouter chat mapper returns normalized ModelResponse with native tool_calls", () => {
  const mapped = mapOpenRouterResponse<{ plan: string }>(
    {
      id: "chatcmpl-1",
      model: "openai/gpt-5.2-chat",
      choices: [
        {
          message: {
            content: JSON.stringify({ plan: "collect" }),
            tool_calls: [
              {
                id: "call_1",
                function: {
                  name: "free.time.current",
                  arguments: JSON.stringify({ timezone: "Etc/UTC" }),
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
        prompt_tokens_details: { cached_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    },
    {
      endpoint: "chat",
      requestedModel: "openai/gpt-5.2-chat",
      requestId: "req_1",
    },
  );

  assert.equal(mapped.provider.endpoint, "chat");
  assert.equal(mapped.provider.requestId, "req_1");
  assert.equal(mapped.output?.plan, "collect");
  assert.equal(mapped.toolIntents.length, 1);
  assert.equal(mapped.toolIntents[0]?.name, "free.time.current");
  assert.deepEqual(mapped.toolIntents[0]?.input, { timezone: "Etc/UTC" });
  assert.equal(mapped.usage?.inputTokens, 12);
  assert.equal(mapped.usage?.outputTokens, 7);
  assert.equal(mapped.usage?.totalTokens, 19);
  assert.equal(mapped.usage?.cachedInputTokens, 5);
  assert.equal(mapped.usage?.reasoningTokens, 3);
});

contractTest("runtime.hermetic", "OpenRouter responses mapper returns normalized ModelResponse", () => {
  const mapped = mapOpenRouterResponse<{ done: boolean }>(
    {
      model: "openai/gpt-5.2-chat",
      output_text: JSON.stringify({ done: true }),
      output: [
        {
          content: [
            {
              type: "function_call",
              id: "fc_1",
              name: "free.weather.current",
              arguments: JSON.stringify({ city: "Boston" }),
            },
          ],
        },
      ],
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    },
    {
      endpoint: "responses",
      requestedModel: "openai/gpt-5.2-chat",
    },
  );

  assert.equal(mapped.provider.endpoint, "responses");
  assert.equal(mapped.output?.done, true);
  assert.equal(mapped.toolIntents.length, 1);
  assert.equal(mapped.toolIntents[0]?.name, "free.weather.current");
  assert.equal(mapped.usage?.totalTokens, 12);
  assert.equal(mapped.usage?.cachedInputTokens, 2);
  assert.equal(mapped.usage?.reasoningTokens, 1);
});

contractTest("runtime.hermetic", "OpenRouter mapper ignores JSON toolIntents when native calls are absent", () => {
  const mapped = mapOpenRouterResponse<{
    toolIntents: Array<{ name: string; input: Record<string, unknown> }>;
  }>(
    {
      model: "openai/gpt-5.2-chat",
      choices: [
        {
          message: {
            content: JSON.stringify({
              toolIntents: [
                {
                  name: "free.time.current",
                  input: { timezone: "UTC" },
                },
              ],
            }),
          },
        },
      ],
    },
    {
      endpoint: "chat",
      requestedModel: "openai/gpt-5.2-chat",
    },
  );

  assert.equal(mapped.toolIntents.length, 0);
});

contractTest("runtime.hermetic", "OpenRouter mapper parses JSON payload wrapped in markdown fences", () => {
  const mapped = mapOpenRouterResponse<{ nextAction: { kind: string } }>(
    {
      model: "openai/gpt-5.2-chat",
      choices: [
        {
          message: {
            content:
              "```json\n{\"nextAction\":{\"kind\":\"finalize\",\"input\":{\"message\":\"done\"}}}\n```",
          },
        },
      ],
    },
    {
      endpoint: "chat",
      requestedModel: "openai/gpt-5.2-chat",
    },
  );

  assert.equal(mapped.output?.nextAction.kind, "finalize");
});

contractTest("runtime.hermetic", "OpenRouter chat mapper parses JSON when content is structured array blocks", () => {
  const mapped = mapOpenRouterResponse<{ nextAction: { kind: string } }>(
    {
      model: "openai/gpt-5.2-chat",
      choices: [
        {
          message: {
            content: [
              {
                type: "text",
                text: "{\"nextAction\":{\"kind\":\"finalize\",\"input\":{\"message\":\"ok\"}}}",
              },
            ],
          },
        },
      ],
    },
    {
      endpoint: "chat",
      requestedModel: "openai/gpt-5.2-chat",
    },
  );

  assert.equal(mapped.output?.nextAction.kind, "finalize");
});

contractTest("runtime.hermetic", "OpenRouter chat mapper parses content blocks with nested text.value", () => {
  const mapped = mapOpenRouterResponse<{ nextAction: { kind: string } }>(
    {
      model: "openai/gpt-5.2-chat",
      choices: [
        {
          message: {
            content: [
              {
                type: "text",
                text: {
                  value: "{\"nextAction\":{\"kind\":\"finalize\",\"input\":{\"message\":\"ok\"}}}",
                },
              },
            ],
          },
        },
      ],
    },
    {
      endpoint: "chat",
      requestedModel: "openai/gpt-5.2-chat",
    },
  );

  assert.equal(mapped.output?.nextAction.kind, "finalize");
});

contractTest("runtime.hermetic", "OpenRouter chat mapper falls back to output_text when choices are missing", () => {
  const mapped = mapOpenRouterResponse<{ nextAction: { kind: string } }>(
    {
      model: "openai/gpt-5.2-chat",
      output_text: "{\"nextAction\":{\"kind\":\"finalize\",\"input\":{\"message\":\"ok\"}}}",
      output: [],
    },
    {
      endpoint: "chat",
      requestedModel: "openai/gpt-5.2-chat",
    },
  );

  assert.equal(mapped.output?.nextAction.kind, "finalize");
});

contractTest("runtime.hermetic", "OpenRouter chat mapper uses structured parsed output when text is absent", () => {
  const mapped = mapOpenRouterResponse<{ message: string }>(
    {
      model: "openai/gpt-5.2-chat",
      choices: [
        {
          message: {
            content: [],
            parsed: {
              message: "I should fetch one more source before finalizing.",
            },
          },
        },
      ],
    },
    {
      endpoint: "chat",
      requestedModel: "openai/gpt-5.2-chat",
    },
  );

  assert.equal(mapped.output?.message, "I should fetch one more source before finalizing.");
});

contractTest("runtime.hermetic", "OpenRouter request builder supports chat default and responses override", () => {
  const chatRequest: ModelRequest = {
    model: "openai/gpt-5.2-chat",
    input: "hello",
  };

  const mappedChat = buildOpenRouterHttpRequest(chatRequest, {
    apiKey: "key",
    model: "openai/gpt-5.2-chat",
    baseUrl: "https://openrouter.ai",
  });

  assert.equal(mappedChat.endpoint, "chat");
  assert.equal(mappedChat.path, "/api/v1/chat/completions");

  const responsesRequest: ModelRequest = {
    model: "openai/gpt-5.2-chat",
    input: "hello",
    providerOptions: {
      openrouter: {
        endpoint: "responses",
      },
    },
  };

  const mappedResponses = buildOpenRouterHttpRequest(responsesRequest, {
    apiKey: "key",
    model: "openai/gpt-5.2-chat",
    baseUrl: "https://openrouter.ai",
  });

  assert.equal(mappedResponses.endpoint, "responses");
  assert.equal(mappedResponses.path, "/api/v1/responses");
});

contractTest("runtime.hermetic", "OpenRouter request builder preserves required tool choice for chat", () => {
  const request: ModelRequest = {
    model: "openai/gpt-5.2-chat",
    input: "hello",
    tools: [
      {
        name: "fs.read_text",
        description: "Read a file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ],
    providerOptions: {
      openrouter: {
        toolChoice: "required",
      },
    },
  };

  const mapped = buildOpenRouterHttpRequest(request, {
    apiKey: "key",
    model: "openai/gpt-5.2-chat",
    baseUrl: "https://openrouter.ai",
  });
  const body = mapped.body as { tool_choice?: unknown; tools?: unknown[]; parallel_tool_calls?: unknown };

  assert.equal(body.tool_choice, "required");
  assert.equal(body.tools?.length, 1);
  assert.equal(body.parallel_tool_calls, true);
});

contractTest("runtime.hermetic", "OpenRouter request builder preserves required tool choice for responses", () => {
  const request: ModelRequest = {
    model: "openai/gpt-5.2-chat",
    input: "hello",
    tools: [
      {
        name: "fs.read_text",
        description: "Read a file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ],
    providerOptions: {
      openrouter: {
        endpoint: "responses",
        toolChoice: "required",
      },
    },
  };

  const mapped = buildOpenRouterHttpRequest(request, {
    apiKey: "key",
    model: "openai/gpt-5.2-chat",
    baseUrl: "https://openrouter.ai",
  });
  const body = mapped.body as { tool_choice?: unknown; tools?: unknown[]; parallel_tool_calls?: unknown };

  assert.equal(body.tool_choice, "required");
  assert.equal(body.tools?.length, 1);
  assert.equal(body.parallel_tool_calls, true);
});

contractTest("runtime.hermetic", "OpenRouter request builder preserves documented tool choices", () => {
  for (const toolChoice of ["auto", "none"] as const) {
    const request: ModelRequest = {
      model: "openai/gpt-5.2-chat",
      input: "hello",
      providerOptions: {
        openrouter: {
          toolChoice,
        },
      },
    };

    const mapped = buildOpenRouterHttpRequest(request, {
      apiKey: "key",
      model: "openai/gpt-5.2-chat",
      baseUrl: "https://openrouter.ai",
    });

    assert.equal((mapped.body as { tool_choice?: unknown }).tool_choice, toolChoice);
  }
});

contractTest("runtime.hermetic", "OpenRouter responses request builder preserves native tool call history", () => {
  const request: ModelRequest = {
    model: "openai/gpt-5.2-chat",
    input: "ignored",
    messages: [
      {
        role: "user",
        content: "List files.",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_fs_list",
            name: "fs.list",
            input: { path: "." },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_fs_list",
        name: "fs.list",
        content: "[]",
      },
    ],
    providerOptions: {
      openrouter: {
        endpoint: "responses",
      },
    },
  };

  const mapped = buildOpenRouterHttpRequest(request, {
    apiKey: "key",
    model: "openai/gpt-5.2-chat",
    baseUrl: "https://openrouter.ai",
  });
  const body = mapped.body as { input?: unknown };
  const input = body.input as Array<Record<string, unknown>>;

  assert.deepEqual(input[1], {
    type: "function_call",
    call_id: "call_fs_list",
    name: "fs_list",
    arguments: JSON.stringify({ path: "." }),
  });
  assert.deepEqual(input[2], {
    type: "function_call_output",
    call_id: "call_fs_list",
    output: "[]",
  });
});

contractTest("runtime.hermetic", "OpenRouter request builder uses json_object when responseFormat=json without schema", () => {
  const request: ModelRequest = {
    model: "openai/gpt-5.2-chat",
    input: "hello",
    responseFormat: "json",
    providerOptions: {
      openrouter: {
        responseSchemaName: "kestrel_agent_action",
      },
    },
  };

  const mapped = buildOpenRouterHttpRequest(request, {
    apiKey: "key",
    model: "openai/gpt-5.2-chat",
    baseUrl: "https://openrouter.ai",
  });

  assert.equal(mapped.endpoint, "chat");
  assert.deepEqual((mapped.body as { response_format?: unknown }).response_format, {
    type: "json_object",
  });
  assert.deepEqual(mapped.structuredOutput, {
    mode: "json_object",
    schemaName: "kestrel_agent_action",
  });
});

contractTest("runtime.hermetic", "OpenRouter request builder uses constrained json_schema when responseFormat=json with schema", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      version: { const: "v1" },
      rationale: { type: "string" },
    },
    required: ["version"],
  };

  const request: ModelRequest = {
    model: "openai/gpt-5.2-chat",
    input: "hello",
    responseFormat: "json",
    responseSchema: schema,
  };

  const mapped = buildOpenRouterHttpRequest(request, {
    apiKey: "key",
    model: "openai/gpt-5.2-chat",
    baseUrl: "https://openrouter.ai",
  });

  assert.equal(mapped.endpoint, "chat");
  const responseFormat = (mapped.body as { response_format?: unknown }).response_format as
    | Record<string, unknown>
    | undefined;
  assert.equal(responseFormat?.type, "json_schema");
  const jsonSchema = (responseFormat?.json_schema ?? {}) as Record<string, unknown>;
  assert.equal(jsonSchema.name, "kestrel_response");
  const normalizedSchema = (jsonSchema.schema ?? {}) as Record<string, unknown>;
  const required = (normalizedSchema.required ?? []) as string[];
  assert.deepEqual(required.sort(), ["rationale", "version"]);
});

contractTest("runtime.hermetic", "OpenRouter request builder fails fast on unsupported schema keywords", () => {
  const request: ModelRequest = {
    model: "openai/gpt-5.2-chat",
    input: "hello",
    responseFormat: "json",
    responseSchema: {
      type: "object",
      properties: {
        ok: { $ref: "#/$defs/ok" },
      },
      required: ["ok"],
    },
  };

  assert.throws(
    () =>
      buildOpenRouterHttpRequest(request, {
        apiKey: "key",
        model: "openai/gpt-5.2-chat",
        baseUrl: "https://openrouter.ai",
      }),
    (error: unknown) => {
      const cast = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "MODEL_PROVIDER_SCHEMA");
      assert.equal(cast.details?.category, "provider_schema");
      return true;
    },
  );
});

contractTest("runtime.hermetic", "OpenRouter preserves typed reasoning details outside assistant answer text", () => {
  const details = [
    { type: "reasoning.summary", summary: "Checked the evidence." },
    { type: "reasoning.encrypted", data: "opaque" },
  ];
  const mapped = mapOpenRouterResponse({
    model: "openai/gpt-5.2",
    choices: [{ message: { content: "Answer only.", reasoning_details: details } }],
  }, { endpoint: "chat", requestedModel: "openai/gpt-5.2" });

  assert.equal(mapped.text, "Answer only.");
  assert.deepEqual(mapped.reasoning?.visible, [
    { format: "summary", text: "Checked the evidence." },
  ]);
  assert.deepEqual(mapped.reasoning?.continuation, [
    { provider: "openrouter", kind: "reasoning_details", value: details },
  ]);

  const request = buildOpenRouterHttpRequest({
    model: "openai/gpt-5.2",
    input: "continue",
    messages: [{ role: "assistant", content: "Answer only." }, { role: "user", content: "Continue." }],
    reasoning: { mode: "provider_visible", continuation: mapped.reasoning?.continuation },
  }, { apiKey: "key", model: "openai/gpt-5.2", baseUrl: "https://openrouter.ai" });
  const messages = request.body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0]?.reasoning_details, details);
});
