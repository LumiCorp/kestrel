import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostedModelRegistration,
  readHostedOpenRouterRouteEvidence,
} from "./hosted-model-registration";
import {
  HOSTED_AGENT_LOOP_QUALIFICATION_CAPABILITIES,
  qualifyHostedAgentLoopModel,
} from "./hosted-model-qualification";
import { GatewayModelProviderResolutionError } from "./gateway-lifecycle-error";

function openRouterRegistrationFixture() {
  return createHostedModelRegistration({
    registrationId: "hosted:gateway-1:z-ai/glm-test",
    revision: "registration-1",
    observedAt: "2026-08-26T00:00:00.000Z",
    modelId: "z-ai/glm-test",
    credentialRevision: "7",
    providerConfiguration: {
      version: "provider_runtime_configuration_v1",
      providerId: "openrouter",
      protocol: "openrouter",
      authentication: {
        mode: "required",
        credentialReference: { source: "hosted", id: "provider.openrouter.hosted" },
      },
      endpoint: "https://openrouter.example/api/v1",
      timeoutMs: 15_000,
      allowedHeaders: [],
      dataHandling: "provider_managed",
    },
    providerEvidence: {
      provider: "openrouter",
      details: {
        id: "z-ai/glm-test",
        supported_parameters: [
          "response_format",
          "structured_outputs",
          "tools",
          "tool_choice",
          "parallel_tool_calls",
          "strict_tool_inputs",
        ],
        endpoints: [{
          id: "provider-a",
          supported_parameters: [
            "response_format",
            "structured_outputs",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "strict_tool_inputs",
          ],
        }],
      },
    },
  });
}

test("hosted approval qualifies the explicit agent-loop contract through OpenRouter codecs", async () => {
  const created = openRouterRegistrationFixture();
  const routeEvidence = readHostedOpenRouterRouteEvidence({
    metadata: { kestrelModelRegistrationEvidenceV1: created.evidence },
    registration: created.registration,
  });
  assert.ok(routeEvidence);
  const payloads: Array<Record<string, unknown>> = [];

  const qualified = await qualifyHostedAgentLoopModel({
    registration: created.registration,
    credential: { revision: "7", apiKey: "test-key" },
    openRouterRouteEvidence: routeEvidence,
    now: () => new Date("2026-08-26T00:02:00.000Z"),
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      payloads.push(payload);
      const hasTools = Array.isArray(payload.tools);
      return new Response(
        JSON.stringify({
          model: "z-ai/glm-test",
          choices: [{
            finish_reason: hasTools ? "tool_calls" : "stop",
            message: hasTools
              ? {
                  tool_calls: [{
                    id: `call-${payloads.length}`,
                    type: "function",
                    function: { name: "probe_tool", arguments: "{}" },
                  }],
                }
              : { content: '{"ok":true}' },
          }],
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(
    payloads.length,
    HOSTED_AGENT_LOOP_QUALIFICATION_CAPABILITIES.length,
    JSON.stringify(qualified.results),
  );
  assert.equal(qualified.registration.qualification.state, "qualified");
  assert.equal(qualified.qualification.state, "qualified");
  assert.deepEqual(
    qualified.results.map((result) => result.outcome),
    ["qualified", "qualified", "qualified", "qualified"],
  );
  assert.equal(qualified.registration.capabilities.providerStrictSchema.state, "qualified");
  assert.equal(qualified.registration.capabilities.nativeTools.state, "qualified");
  assert.equal(qualified.registration.capabilities.requiredToolChoice.state, "qualified");
  assert.equal(qualified.registration.capabilities.strictToolInputs.state, "qualified");
  assert.equal(qualified.registration.capabilities.parallelToolCalls.state, "declared");
  const strictSchema = payloads[0]!;
  assert.equal(
    ((strictSchema.response_format as Record<string, unknown>).json_schema as Record<string, unknown>).strict,
    true,
  );
  assert.deepEqual(
    (strictSchema.provider as Record<string, unknown>).order,
    ["provider-a"],
  );
  assert.equal(payloads[1]!.tool_choice, "auto");
  assert.equal(payloads[2]!.tool_choice, "required");
  const strictTools = payloads[3]!;
  assert.equal(strictTools.tool_choice, "required");
  assert.equal(
    ((strictTools.tools as Array<Record<string, unknown>>)[0]!.function as Record<string, unknown>).strict,
    true,
  );
});

test("hosted approval does not persist a transport failure as qualification evidence", async () => {
  const created = openRouterRegistrationFixture();
  const routeEvidence = readHostedOpenRouterRouteEvidence({
    metadata: { kestrelModelRegistrationEvidenceV1: created.evidence },
    registration: created.registration,
  });
  assert.ok(routeEvidence);

  await assert.rejects(
    qualifyHostedAgentLoopModel({
      registration: created.registration,
      credential: { revision: "7", apiKey: "test-key" },
      openRouterRouteEvidence: routeEvidence,
      fetchImpl: async () => {
        throw new Error("provider unavailable");
      },
    }),
    (error: unknown) =>
      error instanceof GatewayModelProviderResolutionError &&
      error.status === 503 &&
      error.retryable === true,
  );
});

test("hosted qualification carries strict and required contracts through OpenAI and Anthropic codecs", async () => {
  for (const fixture of [
    {
      provider: "openai" as const,
      modelId: "gpt-4.1-mini",
      endpoint: "https://openai.example/v1",
      evidence: { provider: "openai" as const, catalogRecord: { id: "gpt-4.1-mini" } },
      path: "/v1/responses",
      response: (hasTools: boolean) => ({
        id: "resp_qualification",
        model: "gpt-4.1-mini",
        status: "completed",
        output: hasTools
          ? [{ type: "function_call", call_id: "call_qualification", name: "probe_tool", arguments: "{}" }]
          : [{ type: "message", content: [{ type: "output_text", text: '{\"ok\":true}' }] }],
      }),
    },
    {
      provider: "anthropic" as const,
      modelId: "claude-sonnet-test",
      endpoint: "https://anthropic.example",
      evidence: {
        provider: "anthropic" as const,
        modelsApiRecord: { id: "claude-sonnet-test", display_name: "Claude Sonnet" },
      },
      path: "/v1/messages",
      response: (hasTools: boolean) => ({
        id: "msg_qualification",
        model: "claude-sonnet-test",
        type: "message",
        role: "assistant",
        stop_reason: hasTools ? "tool_use" : "end_turn",
        content: hasTools
          ? [{ type: "tool_use", id: "call_qualification", name: "probe_tool", input: {} }]
          : [{ type: "text", text: '{\"ok\":true}' }],
      }),
    },
  ] as const) {
    const created = createHostedModelRegistration({
      registrationId: `hosted:gateway-1:${fixture.modelId}`,
      revision: "registration-1",
      observedAt: "2026-08-26T00:00:00.000Z",
      modelId: fixture.modelId,
      credentialRevision: "7",
      providerConfiguration: {
        version: "provider_runtime_configuration_v1",
        providerId: fixture.provider,
        protocol: fixture.provider,
        authentication: { mode: "required", credentialReference: { source: "hosted", id: `provider.${fixture.provider}.hosted` } },
        endpoint: fixture.endpoint,
        timeoutMs: 15_000,
        allowedHeaders: [],
        dataHandling: "provider_managed",
      },
      providerEvidence: fixture.evidence,
    });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const qualified = await qualifyHostedAgentLoopModel({
      registration: created.registration,
      credential: { revision: "7", apiKey: "test-key" },
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url: String(url), body });
        return new Response(JSON.stringify(fixture.response(Array.isArray(body.tools))), { status: 200 });
      },
    });
    assert.deepEqual(qualified.results.map((result) => result.outcome), ["qualified", "qualified", "qualified", "qualified"]);
    assert.ok(requests.every((request) => request.url.endsWith(fixture.path)));
    const strictSchema = requests[0]!.body;
    const outputFormat = fixture.provider === "openai"
      ? ((strictSchema.text as Record<string, unknown>).format as Record<string, unknown>)
      : ((strictSchema.output_config as Record<string, unknown>).format as Record<string, unknown>);
    assert.equal(outputFormat.type, "json_schema");
    assert.deepEqual(
      requests[1]!.body.tool_choice,
      fixture.provider === "openai"
        ? "auto"
        : { type: "auto", disable_parallel_tool_use: true },
    );
    const requiredChoice = requests[2]!.body.tool_choice as Record<string, unknown> | string;
    assert.deepEqual(requiredChoice, fixture.provider === "openai" ? "required" : { type: "any", disable_parallel_tool_use: true });
    const strictTool = (requests[3]!.body.tools as Array<Record<string, unknown>>)[0]!;
    assert.equal(strictTool.strict, true);
  }
});
