import assert from "node:assert/strict";
import test from "node:test";

import { createModelRequestV2 } from "../../src/kestrel/contracts/model-registration.js";
import {
  buildOpenRouterHttpRequestV2,
  mapOpenRouterResponseV2,
  type OpenRouterQualifiedRouteEvidence,
} from "../../models/openrouter/OpenRouterV2Codec.js";

const env = {
  apiKey: "test",
  model: "z-ai/glm-5.2:free",
  baseUrl: "https://openrouter.example",
};

function route(
  overrides: Partial<OpenRouterQualifiedRouteEvidence> = {},
): OpenRouterQualifiedRouteEvidence {
  return {
    modelId: "z-ai/glm-5.2:free",
    endpoint: "chat",
    supportedParameters: [
      "response_format",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "reasoning",
      "reasoning_details",
    ],
    endpoints: [
      {
        id: "together",
        supportedParameters: [
          "response_format",
          "tools",
          "tool_choice",
          "parallel_tool_calls",
          "reasoning",
          "reasoning_details",
        ],
      },
    ],
    routing: {
      kind: "fixed",
      policyId: "glm-chat",
      allowedEndpointIds: ["together"],
    },
    sourceHash: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

function request(input: {
  endpoint?: "chat" | "responses";
  output?: "text" | "json_object" | "json_schema";
  tools?: boolean;
  parallelism?: "forbidden" | "allowed" | "required";
  continuation?: boolean;
}) {
  const output = input.output ?? "text";
  const tools = input.tools ?? false;
  const continuation = input.continuation ?? false;
  return createModelRequestV2({
    version: "model_request_v2",
    model: "z-ai/glm-5.2:free",
    input: "hello",
    ...(output === "json_schema"
      ? {
          responseFormat: "json" as const,
          responseSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        }
      : output === "json_object"
        ? { responseFormat: "json" as const }
        : { responseFormat: "text" as const }),
    ...(tools
      ? {
          tools: [
            {
              name: "lookup",
              description: "Lookup a value.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false,
              },
            },
          ],
        }
      : {}),
    ...(continuation
      ? {
          reasoning: {
            mode: "provider_visible" as const,
            continuation: [
              {
                provider: "openrouter" as const,
                kind: "reasoning_details" as const,
                value: [{ type: "reasoning.text", text: "opaque" }],
              },
            ],
          },
        }
      : {}),
    requirements: {
      runtimeRole: "test",
      output:
        output === "text"
          ? { kind: "text" as const, assurance: "none" as const }
          : output === "json_object"
            ? {
                kind: "json_object" as const,
                assurance: "json_syntax" as const,
              }
            : {
                kind: "json_schema" as const,
                assurance: "provider_strict_schema" as const,
                schemaName: "result",
              },
      tools: tools
        ? {
            choice: "required" as const,
            strictArguments: true,
            parallelism: input.parallelism ?? "forbidden",
          }
        : {
            choice: "none" as const,
            strictArguments: false,
            parallelism: "forbidden" as const,
          },
      reasoning: continuation
        ? {
            mode: "provider_visible" as const,
            continuationKinds: ["reasoning_details" as const],
          }
        : { mode: "off" as const, continuationKinds: [] },
      streaming: { required: false, terminalBehavior: "not_required" as const },
      inputModalities: ["text" as const],
      endpoint: input.endpoint ?? "chat",
    },
  });
}

test("OpenRouter V2 Chat emits only its exact structured-output and routing contract", () => {
  const mapped = buildOpenRouterHttpRequestV2(
    request({ output: "json_schema", tools: true, parallelism: "forbidden" }),
    env,
    route(),
  );
  assert.equal(mapped.path, "/api/v1/chat/completions");
  assert.deepEqual(
    (mapped.body.provider as Record<string, unknown>).require_parameters,
    true,
  );
  assert.equal(
    (mapped.body.provider as Record<string, unknown>).allow_fallbacks,
    false,
  );
  assert.equal(
    (mapped.body.response_format as Record<string, unknown>).type,
    "json_schema",
  );
  assert.equal(
    mapped.body.text as Record<string, unknown> | undefined,
    undefined,
  );
  assert.equal(mapped.body.parallel_tool_calls, false);
  const tool = (mapped.body.tools as Array<Record<string, unknown>>)[0]!
    .function as Record<string, unknown>;
  assert.equal(tool.strict, true);
});

test("OpenRouter V2 Responses uses OpenResponses text.format and direct functions", () => {
  const mapped = buildOpenRouterHttpRequestV2(
    request({
      endpoint: "responses",
      output: "json_schema",
      tools: true,
      parallelism: "allowed",
    }),
    env,
    route({
      endpoint: "responses",
      supportedParameters: [
        "response_format",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
      ],
    }),
  );
  assert.equal(mapped.path, "/api/v1/responses");
  assert.equal(mapped.body.response_format as unknown, undefined);
  const format = (mapped.body.text as Record<string, unknown>).format as Record<
    string,
    unknown
  >;
  assert.equal(format.type, "json_schema");
  assert.equal(format.name, "result");
  assert.equal(format.strict, true);
  assert.deepEqual((format.schema as Record<string, unknown>).required, ["ok"]);
  assert.equal(format.json_schema, undefined);
  const tool = (mapped.body.tools as Array<Record<string, unknown>>)[0]!;
  assert.equal(tool.type, "function");
  assert.equal(tool.name, "lookup");
  assert.equal(mapped.body.parallel_tool_calls, true);
});

test("OpenRouter V2 sends no optional model-shaping parameters for plain text", () => {
  const mapped = buildOpenRouterHttpRequestV2(
    request({}),
    env,
    route({ supportedParameters: [] }),
  );
  assert.deepEqual(Object.keys(mapped.body).sort(), [
    "messages",
    "model",
    "provider",
  ]);
});

test("OpenRouter V2 fails closed for no eligible endpoint intersection", () => {
  assert.throws(
    () =>
      buildOpenRouterHttpRequestV2(
        request({ output: "json_object" }),
        env,
        route({
          endpoints: [{ id: "together", supportedParameters: [] }],
        }),
      ),
    /no eligible provider endpoint/u,
  );
  assert.throws(
    () =>
      buildOpenRouterHttpRequestV2(
        request({ output: "json_schema", tools: true }),
        env,
        route({
          supportedParameters: [
            "response_format",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
          ],
          endpoints: [
            {
              id: "together",
              supportedParameters: ["response_format", "tools"],
            },
            {
              id: "novita",
              supportedParameters: ["tool_choice", "parallel_tool_calls"],
            },
          ],
          routing: {
            kind: "provider",
            policyId: "glm-split-capabilities",
            allowedEndpointIds: ["together", "novita"],
          },
        }),
      ),
    /no eligible provider endpoint/u,
  );
  assert.throws(
    () =>
      buildOpenRouterHttpRequestV2(
        request({ endpoint: "responses" }),
        env,
        route(),
      ),
    /does not match the requested endpoint/u,
  );
  assert.throws(
    () =>
      buildOpenRouterHttpRequestV2(
        request({}),
        env,
        route({
          routing: {
            kind: "provider",
            policyId: "none",
            allowedEndpointIds: [],
          },
        }),
      ),
    /no eligible provider endpoint/u,
  );
  assert.throws(
    () =>
      buildOpenRouterHttpRequestV2(
        request({ endpoint: "responses", continuation: true }),
        env,
        route({
          endpoint: "responses",
          supportedParameters: ["reasoning", "reasoning_details"],
        }),
      ),
    /continuation is unsupported/u,
  );
});

test("OpenRouter V2 routes only to endpoints that satisfy every required parameter", () => {
  const mapped = buildOpenRouterHttpRequestV2(
    request({ output: "json_schema", tools: true }),
    env,
    route({
      supportedParameters: [
        "response_format",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
      ],
      endpoints: [
        {
          id: "together",
          supportedParameters: ["response_format", "tools", "tool_choice"],
        },
        {
          id: "novita",
          supportedParameters: [
            "response_format",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
          ],
        },
      ],
      routing: {
        kind: "provider",
        policyId: "glm-qualified",
        allowedEndpointIds: ["together", "novita"],
      },
    }),
  );

  assert.deepEqual((mapped.body.provider as Record<string, unknown>).order, [
    "novita",
  ]);
});

test("OpenRouter V2 Responses accepts direct function calls and refuses argument repair", () => {
  const mapped = mapOpenRouterResponseV2(
    {
      status: "completed",
      model: "z-ai/glm-5.2:free",
      output: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "lookup",
          arguments: '{"query":"Kestrel"}',
        },
      ],
    },
    { endpoint: "responses", requestedModel: "z-ai/glm-5.2:free" },
  );
  assert.deepEqual(mapped.toolIntents, [
    { id: "call-1", name: "lookup", input: { query: "Kestrel" } },
  ]);
  const malformed = mapOpenRouterResponseV2(
    {
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "lookup",
          arguments: '{"query":',
        },
      ],
    },
    {
      endpoint: "responses",
      requestedModel: "z-ai/glm-5.2:free",
      requestId: "req-preserve",
    },
  );
  assert.equal(malformed.terminal.state, "malformed");
  assert.equal(malformed.terminal.providerTerminalEvent, "response.completed");
  assert.equal(malformed.provider.requestId, "req-preserve");
  const fenced = mapOpenRouterResponseV2<{ ok: boolean }>(
    { status: "completed", output_text: '```json\n{"ok":true}\n```' },
    { endpoint: "responses", requestedModel: "z-ai/glm-5.2:free" },
  );
  assert.equal(fenced.output, undefined);
});
