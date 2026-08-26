import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelRequestV2,
  type ModelRequestV2,
  PROVIDER_RUNTIME_CONFIGURATION_VERSION,
} from "../../src/kestrel/contracts/model-registration.js";
import { createAnthropicInvoker } from "../../models/anthropic/AnthropicInvoker.js";
import {
  ANTHROPIC_MODELS_API_TRANSLATOR_REVISION,
  translateAnthropicModelsApiModel,
} from "../../models/anthropic/AnthropicModelManifest.js";
import {
  buildAnthropicHttpRequestV2,
  mapAnthropicResponseV2,
} from "../../models/anthropic/AnthropicMapper.js";

const env = {
  apiKey: "test-key",
  model: "claude-sonnet-test",
  baseUrl: "https://api.anthropic.test",
  version: "2023-06-01",
};

test("Anthropic V2 combines native output_config.format, ordinary tools, named choice, and requested thinking", () => {
  const mapped = buildAnthropicHttpRequestV2(
    request({
      output: "json_schema",
      tools: true,
      choice: "named",
      reasoning: true,
    }),
    env,
  );

  assert.deepEqual(mapped.body.output_config, {
    format: { type: "json_schema", schema: schema() },
    effort: "high",
  });
  assert.deepEqual(mapped.body.thinking, {
    type: "adaptive",
    display: "summarized",
  });
  assert.deepEqual(mapped.body.tool_choice, { type: "tool", name: "lookup" });
  assert.deepEqual(mapped.body.tools, [
    {
      name: "lookup",
      description: "Find a record.",
      input_schema: toolSchema(),
      strict: true,
    },
  ]);
});

test("Anthropic V2 fails closed when strict tool input cannot be encoded natively", () => {
  const source = request({ tools: true });
  const impossible: ModelRequestV2 = {
    ...source,
    tools: undefined,
    requirements: {
      ...source.requirements,
      tools: {
        choice: "required",
        strictArguments: true,
        parallelism: "forbidden",
      },
    },
  };

  assert.throws(
    () => buildAnthropicHttpRequestV2(impossible, env),
    /strict tool input requires at least one native tool/u,
  );
});

test("Anthropic V2 omits thinking and output configuration that were not requested", () => {
  const mapped = buildAnthropicHttpRequestV2(request({}), env);
  assert.equal(mapped.body.thinking, undefined);
  assert.equal(mapped.body.output_config, undefined);
  assert.deepEqual(mapped.body.tool_choice, { type: "none" });
});

test("Anthropic V2 preserves native thinking signatures and fails malformed native tool input", () => {
  const thinking = {
    type: "thinking",
    thinking: "Checked.",
    signature: "opaque",
  };
  const mapped = mapAnthropicResponseV2(
    {
      model: "claude-sonnet-test",
      stop_reason: "tool_use",
      content: [
        thinking,
        {
          type: "tool_use",
          id: "call_1",
          name: "lookup",
          input: { query: "Kestrel" },
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    },
    { requestedModel: "claude-sonnet-test" },
  );
  assert.equal(mapped.provider.endpoint, "messages");
  assert.equal(mapped.terminal.state, "completed");
  assert.deepEqual(mapped.reasoning?.continuation, [
    { provider: "anthropic", kind: "signature", value: thinking },
  ]);
  assert.deepEqual(mapped.toolIntents, [
    { id: "call_1", name: "lookup", input: { query: "Kestrel" } },
  ]);
  assert.throws(
    () =>
      mapAnthropicResponseV2(
        {
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "call_1", name: "lookup", input: null },
          ],
        },
        { requestedModel: "claude-sonnet-test" },
      ),
    /without a valid name and object input/u,
  );
});

test("Anthropic V2 preserves and replays ordinary and redacted thinking blocks in provider order", () => {
  const thinking = {
    type: "thinking",
    thinking: "Checked.",
    signature: "ordinary-opaque",
  };
  const redactedThinking = {
    type: "redacted_thinking",
    data: "redacted-opaque",
    signature: "redacted-signature",
  };
  const mapped = mapAnthropicResponseV2(
    {
      model: "claude-sonnet-test",
      stop_reason: "end_turn",
      content: [thinking, redactedThinking],
    },
    { requestedModel: "claude-sonnet-test" },
  );
  assert.deepEqual(mapped.reasoning?.continuation, [
    {
      provider: "anthropic",
      kind: "signature",
      value: [thinking, redactedThinking],
    },
  ]);

  const source = request({ reasoning: true });
  const { fingerprints: _fingerprints, ...sourceAuthoring } = source;
  const replay = createModelRequestV2({
    ...sourceAuthoring,
    messages: [
      { role: "user", content: "Find Kestrel." },
      { role: "assistant", content: "I checked." },
    ],
    reasoning: {
      mode: "provider_visible",
      effort: "high",
      continuation: mapped.reasoning?.continuation,
    },
    requirements: {
      ...source.requirements,
      reasoning: {
        mode: "provider_visible",
        effort: "high",
        continuationKinds: ["signature"],
      },
    },
  });
  const body = buildAnthropicHttpRequestV2(replay, env).body;
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "Find Kestrel." }] },
    {
      role: "assistant",
      content: [
        thinking,
        redactedThinking,
        { type: "text", text: "I checked." },
      ],
    },
  ]);
});

test("Anthropic V2 stream requires message_stop and never repairs malformed input deltas", async () => {
  const invoker = createAnthropicInvoker({
    env,
    fetchImpl: (async () =>
      new Response(
        [
          {
            type: "message_start",
            message: { model: "claude-sonnet-test", usage: {} },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "call_1",
              name: "lookup",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"query":' },
          },
          { type: "content_block_stop", index: 0 },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      )) as typeof fetch,
  });
  await assert.rejects(
    invoker(request({ tools: true }), { onEvent: () => undefined }),
    /malformed tool input JSON/u,
  );
});

test("Anthropic V2 rejects foreign continuation before native Messages serialization", () => {
  const source = request({ reasoning: true });
  const { fingerprints: _fingerprints, ...sourceAuthoring } = source;
  const withForeign = createModelRequestV2({
    ...sourceAuthoring,
    reasoning: {
      mode: "provider_visible",
      effort: "high",
      continuation: [
        { provider: "openai", kind: "encrypted_content", value: "opaque" },
      ],
    },
    requirements: {
      ...source.requirements,
      reasoning: {
        mode: "provider_visible",
        effort: "high",
        continuationKinds: ["encrypted_content"],
      },
    },
  });
  assert.throws(
    () => buildAnthropicHttpRequestV2(withForeign, env),
    /another provider or kind/u,
  );
});

test("Anthropic V2 refuses to detach a native continuation from its preceding assistant block", () => {
  const source = request({ reasoning: true });
  const { fingerprints: _fingerprints, ...sourceAuthoring } = source;
  const withContinuation = createModelRequestV2({
    ...sourceAuthoring,
    reasoning: {
      mode: "provider_visible",
      effort: "high",
      continuation: [
        {
          provider: "anthropic",
          kind: "signature",
          value: {
            type: "thinking",
            thinking: "Checked.",
            signature: "opaque",
          },
        },
      ],
    },
    requirements: {
      ...source.requirements,
      reasoning: {
        mode: "provider_visible",
        effort: "high",
        continuationKinds: ["signature"],
      },
    },
  });
  assert.throws(
    () => buildAnthropicHttpRequestV2(withContinuation, env),
    /preceding assistant message/u,
  );
});

test("Anthropic Models API evidence binds the exact returned identity but never qualifies it", () => {
  const registration = translateAnthropicModelsApiModel({
    registrationId: "anthropic:claude-sonnet-test:messages:v1",
    revision: "models-api-page-12",
    observedAt: "2026-08-26T00:00:00.000Z",
    modelId: "claude-sonnet-test",
    modelsApiRecord: {
      id: "claude-sonnet-test",
      display_name: "Claude Sonnet",
    },
    providerConfiguration: providerConfiguration(),
    credentialRevision: "credential-v1",
  });
  assert.equal(registration.qualification.state, "pending");
  assert.equal(
    registration.adapterRevision,
    ANTHROPIC_MODELS_API_TRANSLATOR_REVISION,
  );
  assert.equal(registration.route.endpointCodec, "anthropic.messages.v2");
  assert.equal(registration.capabilities.nativeTools.state, "declared");
  assert.match(registration.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.throws(
    () =>
      translateAnthropicModelsApiModel({
        registrationId: "anthropic:wrong:messages:v1",
        revision: "models-api-page-12",
        observedAt: "2026-08-26T00:00:00.000Z",
        modelId: "claude-sonnet-test",
        modelsApiRecord: { id: "claude-other" },
        providerConfiguration: providerConfiguration(),
      }),
    /does not match/u,
  );
});

function request(
  input: {
    output?: "text" | "json_schema";
    tools?: boolean;
    choice?: "none" | "named";
    reasoning?: boolean;
  } = {},
) {
  const output = input.output ?? "text";
  const tools = input.tools ?? false;
  const reasoning = input.reasoning ?? false;
  return createModelRequestV2({
    version: "model_request_v2",
    model: "claude-sonnet-test",
    input: "Find Kestrel.",
    ...(output === "json_schema"
      ? { responseFormat: "json" as const, responseSchema: schema() }
      : { responseFormat: "text" as const }),
    ...(tools
      ? {
          tools: [
            {
              name: "lookup",
              description: "Find a record.",
              inputSchema: toolSchema(),
            },
          ],
        }
      : {}),
    ...(reasoning
      ? {
          reasoning: {
            mode: "provider_visible" as const,
            effort: "high" as const,
          },
        }
      : {}),
    requirements: {
      runtimeRole: "agent_action",
      output:
        output === "json_schema"
          ? {
              kind: "json_schema" as const,
              assurance: "provider_strict_schema" as const,
              schemaName: "result",
            }
          : { kind: "text" as const, assurance: "none" as const },
      tools: tools
        ? {
            choice: input.choice ?? ("named" as const),
            ...(input.choice === "named" || input.choice === undefined
              ? { toolName: "lookup" }
              : {}),
            strictArguments: true,
            parallelism: "allowed" as const,
          }
        : {
            choice: "none" as const,
            strictArguments: false,
            parallelism: "forbidden" as const,
          },
      reasoning: reasoning
        ? {
            mode: "provider_visible" as const,
            effort: "high" as const,
            continuationKinds: [],
          }
        : { mode: "off" as const, continuationKinds: [] },
      streaming: { required: false, terminalBehavior: "not_required" as const },
      inputModalities: ["text" as const],
      endpoint: "messages" as const,
    },
  });
}

function schema() {
  return {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
}

function toolSchema() {
  return {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  };
}

function providerConfiguration() {
  return {
    version: PROVIDER_RUNTIME_CONFIGURATION_VERSION,
    providerId: "anthropic" as const,
    protocol: "anthropic" as const,
    authentication: {
      mode: "required" as const,
      credentialReference: {
        source: "local-core",
        id: "provider.anthropic.default",
      },
    },
    endpoint: "https://api.anthropic.com/v1",
    timeoutMs: 60_000,
    allowedHeaders: [],
    dataHandling: "provider_managed" as const,
  };
}
