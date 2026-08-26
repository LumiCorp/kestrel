import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelRequestV2,
  PROVIDER_RUNTIME_CONFIGURATION_VERSION,
} from "../../src/kestrel/contracts/model-registration.js";
import { createOpenAiInvoker } from "../../models/openai/OpenAiInvoker.js";
import {
  buildOpenAiHttpRequest,
  mapOpenAiResponseV2,
} from "../../models/openai/OpenAiMapper.js";
import {
  OPENAI_MODEL_MANIFEST_REVISION,
  translateOpenAiManifestModel,
} from "../../models/openai/OpenAiModelManifest.js";

const env = {
  providerName: "openai" as const,
  providerLabel: "OpenAI",
  apiKey: "test-key",
  model: "gpt-4.1-mini",
  baseUrl: "https://api.openai.test",
};

test("OpenAI V2 codecs keep Chat response_format separate from Responses text.format", () => {
  const chat = buildOpenAiHttpRequest(request("chat"), env);
  const responses = buildOpenAiHttpRequest(request("responses"), env);

  assert.deepEqual(chat.body.response_format, {
    type: "json_schema",
    json_schema: {
      name: "result",
      schema: responseSchema(),
      strict: true,
    },
  });
  assert.deepEqual(responses.body.text, {
    format: {
      type: "json_schema",
      name: "result",
      schema: responseSchema(),
      strict: true,
    },
  });
  assert.deepEqual(chat.body.tool_choice, {
    type: "function",
    function: { name: "lookup" },
  });
  assert.deepEqual(responses.body.tool_choice, {
    type: "function",
    name: "lookup",
  });
  assert.equal(chat.body.parallel_tool_calls, false);
  assert.equal(responses.body.parallel_tool_calls, false);
});

test("OpenAI Responses replays encrypted reasoning before the previous function call", () => {
  const continuation = {
    type: "reasoning",
    encrypted_content: "opaque",
  };
  const mapped = buildOpenAiHttpRequest(
    createModelRequestV2({
      ...requestAuthoring("responses"),
      responseFormat: "text",
      responseSchema: undefined,
      tools: undefined,
      requirements: {
        ...requestAuthoring("responses").requirements,
        output: { kind: "text", assurance: "none" },
        tools: {
          choice: "none",
          strictArguments: false,
          parallelism: "forbidden",
        },
        reasoning: {
          mode: "summary",
          continuationKinds: ["encrypted_content"],
        },
      },
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "lookup", input: { query: "Kestrel" } },
          ],
        },
        { role: "tool", toolCallId: "call_1", content: "result" },
        { role: "user", content: "continue" },
      ],
      reasoning: {
        mode: "summary",
        continuation: [
          {
            provider: "openai",
            kind: "encrypted_content",
            value: continuation,
          },
        ],
      },
    }),
    env,
  );
  const input = mapped.body.input as Array<Record<string, unknown>>;
  assert.deepEqual(
    input.map((item) => item.type ?? item.role),
    ["assistant", "reasoning", "function_call", "function_call_output", "user"],
  );
});

test("OpenAI V2 decoder does not heal prose JSON or malformed function arguments", () => {
  const decoded = mapOpenAiResponseV2(
    {
      model: "gpt-4.1-mini",
      choices: [
        { finish_reason: "stop", message: { content: 'Here: {"ok":true}' } },
      ],
    },
    responseContext("chat"),
  );
  assert.equal(decoded.output, undefined);
  assert.equal(decoded.terminal.state, "completed");

  assert.throws(
    () =>
      mapOpenAiResponseV2(
        {
          model: "gpt-4.1-mini",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  {
                    id: "call_1",
                    function: { name: "lookup", arguments: "not-json" },
                  },
                ],
              },
            },
          ],
        },
        responseContext("chat"),
      ),
    (error: unknown) =>
      (error as { code?: string }).code === "MODEL_MALFORMED_TOOL_ARGUMENTS",
  );
});

test("OpenAI stream requires its endpoint terminal event and normalizes Responses terminal state", async () => {
  const invoker = createOpenAiInvoker({
    env,
    fetchImpl: (async () =>
      new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch,
  });
  await assert.rejects(
    invoker(request("responses"), { onEvent: () => undefined }),
    (error: unknown) =>
      (error as { code?: string }).code === "MODEL_BAD_RESPONSE",
  );

  const incomplete = mapOpenAiResponseV2(
    {
      model: "gpt-4.1-mini",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
    },
    responseContext("responses"),
  );
  assert.equal(incomplete.terminal.state, "truncated");
});

test("OpenAI exact-model manifest is fingerprinted declaration, never qualification", () => {
  const registration = translateOpenAiManifestModel({
    registrationId: "openai:gpt-4.1-mini:responses:v1",
    revision: "openai-catalog-v1",
    modelId: "gpt-4.1-mini",
    endpoint: "responses",
    providerConfiguration: providerConfiguration(),
    credentialRevision: "credential-v1",
  });
  assert.equal(registration.adapterRevision, OPENAI_MODEL_MANIFEST_REVISION);
  assert.equal(registration.qualification.state, "pending");
  assert.equal(registration.capabilities.nativeTools.state, "declared");
  assert.equal(registration.route.endpointCodec, "openai.responses.v2");
  assert.match(registration.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.throws(
    () =>
      translateOpenAiManifestModel({
        registrationId: "openai:unknown:responses:v1",
        revision: "openai-catalog-v1",
        modelId: "gpt-unknown",
        endpoint: "responses",
        providerConfiguration: providerConfiguration(),
      }),
    /no exact responses entry/u,
  );
});

function request(endpoint: "chat" | "responses") {
  return createModelRequestV2(requestAuthoring(endpoint));
}

function requestAuthoring(endpoint: "chat" | "responses") {
  return {
    version: "model_request_v2" as const,
    model: "gpt-4.1-mini",
    input: "Find Kestrel.",
    responseFormat: "json" as const,
    responseSchema: responseSchema(),
    tools: [
      {
        name: "lookup",
        description: "Find a record.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
    requirements: {
      runtimeRole: "agent_action",
      output: {
        kind: "json_schema" as const,
        assurance: "local_schema_validation" as const,
        schemaName: "result",
      },
      tools: {
        choice: "named" as const,
        toolName: "lookup",
        strictArguments: true,
        parallelism: "forbidden" as const,
      },
      reasoning: { mode: "off" as const, continuationKinds: [] },
      streaming: { required: false, terminalBehavior: "not_required" as const },
      inputModalities: ["text" as const],
      endpoint,
    },
  };
}

function responseSchema() {
  return {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
}

function responseContext(endpoint: "chat" | "responses") {
  return {
    providerName: "openai" as const,
    endpoint,
    requestedModel: "gpt-4.1-mini",
  };
}

function providerConfiguration() {
  return {
    version: PROVIDER_RUNTIME_CONFIGURATION_VERSION,
    providerId: "openai" as const,
    protocol: "openai" as const,
    authentication: {
      mode: "required" as const,
      credentialReference: {
        source: "local-core",
        id: "provider.openai.default",
      },
    },
    endpoint: "https://api.openai.com/v1",
    timeoutMs: 60_000,
    allowedHeaders: ["openai-organization", "openai-project"],
    dataHandling: "provider_managed" as const,
  };
}
