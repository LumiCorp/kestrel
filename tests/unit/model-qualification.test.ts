import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelRegistrationV2,
  createModelRequestV2,
  MODEL_REGISTRATION_V2_VERSION,
  PROVIDER_RUNTIME_CONFIGURATION_VERSION,
  type ModelRequestV2,
} from "../../src/kestrel/contracts/model-registration.js";
import type { ModelGateway, ModelRequest } from "../../src/kestrel/contracts/model-io.js";
import {
  bindModelQualificationGateway,
  createModelQualificationBinding,
  ModelQualificationService,
  runLiveModelQualification,
  type ModelQualificationCapability,
  type ModelQualificationProbe,
} from "../../src/kestrel/model-qualification.js";

test("qualification probes bind exact evidence and keep GLM-like partial support independent", async () => {
  const clock = new Date("2026-08-26T12:00:00.000Z");
  const service = new ModelQualificationService({
    freshnessMs: 60_000,
    now: () => clock,
  });
  const observed: ModelQualificationCapability[] = [];
  const run = await service.refresh({
    registration: registration(),
    credentialRevision: "credential-1",
    probeRevision: "probe-1",
    probes: [
      probe("json_syntax"),
      probe("local_schema_validation"),
      probe("provider_strict_schema"),
      probe("required_tool_choice"),
      {
        capability: "strict_tool_inputs",
        unsupportedReason: "The exact endpoint codec cannot encode strict tool inputs.",
      },
    ],
    gateway: fakeGateway(async (request) => {
        const capability = capabilityFor(request as ModelRequestV2);
        observed.push(capability);
        const failed =
          capability === "provider_strict_schema" ||
          capability === "required_tool_choice";
        return failed ? failedResponse() : completedResponse();
    }),
  });

  assert.deepEqual(observed.sort(), [
    "json_syntax",
    "local_schema_validation",
    "provider_strict_schema",
    "required_tool_choice",
  ]);
  assert.deepEqual(
    run.results.map(({ capability, outcome }) => [capability, outcome]),
    [
      ["json_syntax", "qualified"],
      ["local_schema_validation", "qualified"],
      ["provider_strict_schema", "failed"],
      ["required_tool_choice", "failed"],
      ["strict_tool_inputs", "unsupported"],
    ],
  );
  assert.equal(run.results[0]?.binding.providerId, "openrouter");
  assert.equal(run.results[0]?.binding.endpointCodec, "openrouter_chat_v2");
  assert.equal(run.results[0]?.binding.registrationFingerprint.length, 71);
  assert.equal(run.results[0]?.requestHash.length, 71);
  assert.equal(run.results[0]?.responseHash?.length, 71);
  assert.equal(
    run.results.find((entry) => entry.capability === "strict_tool_inputs")?.reason,
    "The exact endpoint codec cannot encode strict tool inputs.",
  );
  assert.equal(
    service.roleReadiness({
      registration: registration(),
      credentialRevision: "credential-1",
      probeRevision: "probe-1",
      requirements: ["json_syntax", "provider_strict_schema"],
    }).ready,
    false,
  );
});

test("qualification refresh is concurrent, fresh-idempotent, and stale only for changed bindings", async () => {
  let calls = 0;
  let now = new Date("2026-08-26T12:00:00.000Z");
  const service = new ModelQualificationService({
    freshnessMs: 1_000,
    now: () => now,
  });
  const input = {
    registration: registration(),
    credentialRevision: "credential-1",
    probeRevision: "probe-1",
    probes: [probe("json_syntax")],
    gateway: fakeGateway(async () => {
        calls += 1;
        return completedResponse();
    }),
  };
  const [first, second] = await Promise.all([
    service.refresh(input),
    service.refresh(input),
  ]);
  assert.equal(first, second);
  assert.equal(calls, 1);
  await service.refresh(input);
  assert.equal(calls, 1);

  now = new Date(now.getTime() + 1_001);
  assert.equal(
    service.read({
      registration: registration(),
      credentialRevision: "credential-1",
      probeRevision: "probe-1",
      capability: "json_syntax",
    }).outcome,
    "stale",
  );
  assert.equal(
    service.read({
      registration: registration("credential-2"),
      credentialRevision: "credential-2",
      probeRevision: "probe-1",
      capability: "json_syntax",
    }).outcome,
    "stale",
  );
});

test("qualification refuses a mislabeled bounded probe before transport", async () => {
  const service = new ModelQualificationService({ freshnessMs: 0 });
  let calls = 0;
  await assert.rejects(
    service.refresh({
      registration: registration(),
      credentialRevision: "credential-1",
      probeRevision: "probe-1",
      probes: [
        {
          capability: "required_tool_choice",
          request: (probe("json_syntax") as { request: ModelRequestV2 }).request,
        },
      ],
      gateway: fakeGateway(async () => {
          calls += 1;
          return completedResponse();
      }),
    }),
    /does not carry its required V2 contract/u,
  );
  assert.equal(calls, 0);
});

test("qualification rejects a gateway that belongs to another exact route before transport", async () => {
  const service = new ModelQualificationService({ freshnessMs: 60_000 });
  let calls = 0;
  const gateway = fakeGateway(async () => {
    calls += 1;
    return completedResponse();
  });
  await assert.rejects(
    service.refresh({
      registration: registration(),
      credentialRevision: "credential-1",
      probeRevision: "probe-1",
      probes: [probe("json_syntax")],
      gateway: {
        ...gateway,
        binding: { ...gateway.binding, apiEndpoint: "https://wrong.example/v1" },
      },
    }),
    /gateway does not match its exact registration route/u,
  );
  assert.equal(calls, 0);
});

test("qualification requires the exact response route and capability-specific proof", async () => {
  const service = new ModelQualificationService({ freshnessMs: 60_000 });
  const run = await service.refresh({
    registration: registration(),
    credentialRevision: "credential-1",
    probeRevision: "probe-1",
    probes: [probe("reasoning_summary"), probe("json_syntax")],
    gateway: fakeGateway(async (request) =>
      capabilityFor(request as ModelRequestV2) === "json_syntax"
        ? { ...completedResponse(), provider: { name: "openrouter", model: "another-model", endpoint: "chat" } }
        : completedResponse(),
    ),
  });
  assert.deepEqual(
    run.results.map(({ capability, outcome }) => [capability, outcome]),
    [
      ["reasoning_summary", "failed"],
      ["json_syntax", "failed"],
    ],
  );
});

test("fresh qualification runs never suppress an independently requested capability", async () => {
  let calls = 0;
  const service = new ModelQualificationService({ freshnessMs: 60_000 });
  const gateway = fakeGateway(async (request) => {
    calls += 1;
    return capabilityFor(request as ModelRequestV2) === "required_tool_choice"
      ? toolResponse()
      : completedResponse();
  });
  const shared = {
    registration: registration(),
    credentialRevision: "credential-1",
    probeRevision: "probe-1",
    gateway,
  };
  await service.refresh({ ...shared, probes: [probe("json_syntax")] });
  await service.refresh({ ...shared, probes: [probe("required_tool_choice")] });
  assert.equal(calls, 2);
  assert.equal(
    service.read({ ...shared, capability: "required_tool_choice" }).outcome,
    "qualified",
  );
});

test("a failed forced refresh retains prior observed proof and live runs stay bounded", async () => {
  const service = new ModelQualificationService({ freshnessMs: 60_000 });
  const shared = {
    registration: registration(),
    credentialRevision: "credential-1",
    probeRevision: "probe-1",
    probes: [probe("json_syntax")],
  };
  await service.refresh({ ...shared, gateway: fakeGateway(async () => completedResponse()) });
  const failed = await service.refresh({
    ...shared,
    force: true,
    gateway: fakeGateway(async () => {
      throw new Error("provider unavailable");
    }),
  });
  assert.equal(failed.results[0]?.outcome, "failed");
  assert.equal(
    service.read({ ...shared, capability: "json_syntax" }).outcome,
    "qualified",
  );
  await assert.rejects(
    runLiveModelQualification({
      service,
      ...shared,
      gateway: fakeGateway(async () => completedResponse()),
      maxProbes: 0,
    }),
    /maxProbes/u,
  );
});

function probe(capability: ModelQualificationCapability): ModelQualificationProbe {
  const requirements: ModelRequestV2["requirements"] = {
    runtimeRole: `qualification.${capability}`,
    output: { kind: "text" as const, assurance: "none" as const },
    tools: {
      choice: "none" as const,
      strictArguments: false,
      parallelism: "forbidden" as const,
    },
    reasoning: { mode: "off", continuationKinds: [] },
    streaming: { required: false, terminalBehavior: "not_required" as const },
    inputModalities: ["text" as const],
    endpoint: "chat" as const,
  };
  if (capability === "json_syntax") {
    requirements.output = { kind: "json_object", assurance: "json_syntax" };
  } else if (capability === "local_schema_validation") {
    requirements.output = { kind: "json_schema", assurance: "local_schema_validation", schemaName: "probe" };
  } else if (capability === "provider_strict_schema") {
    requirements.output = { kind: "json_schema", assurance: "provider_strict_schema", schemaName: "probe" };
  } else if (capability === "native_tools") {
    requirements.tools = { choice: "auto", strictArguments: false, parallelism: "forbidden" };
  } else if (capability === "required_tool_choice") {
    requirements.tools = { choice: "required", strictArguments: false, parallelism: "forbidden" };
  } else if (capability === "strict_tool_inputs") {
    requirements.tools = { choice: "required", strictArguments: true, parallelism: "forbidden" };
  } else if (capability === "parallel_tool_calls") {
    requirements.tools = { choice: "required", strictArguments: true, parallelism: "required" };
  } else if (capability === "reasoning_summary") {
    requirements.reasoning = { mode: "summary", continuationKinds: [] };
  } else if (capability === "reasoning_provider_visible") {
    requirements.reasoning = { mode: "provider_visible", continuationKinds: [] };
  } else if (capability === "continuation_encrypted_content") {
    requirements.reasoning = { mode: "provider_visible", continuationKinds: ["encrypted_content"] };
  } else if (capability === "continuation_signature") {
    requirements.reasoning = { mode: "provider_visible", continuationKinds: ["signature"] };
  } else if (capability === "continuation_reasoning_details") {
    requirements.reasoning = { mode: "provider_visible", continuationKinds: ["reasoning_details"] };
  } else if (capability === "streaming_terminal") {
    requirements.streaming = { required: true, terminalBehavior: "required" };
  }
  return {
    capability,
    request: createModelRequestV2({
      version: "model_request_v2",
      model: "z-ai/glm-test",
      input: "qualification probe",
      responseFormat:
        requirements.output.kind === "text" ? "text" : "json",
      ...(requirements.output.kind === "json_schema"
        ? {
            responseSchema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
          }
        : {}),
      ...(requirements.tools.choice !== "none"
        ? {
            tools: [
              {
                name: "probe_tool",
                description: "Qualification probe tool.",
                inputSchema: {
                  type: "object",
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            ],
          }
        : {}),
      requirements,
    }),
  };
}

function capabilityFor(request: ModelRequestV2): ModelQualificationCapability {
  return request.requirements.runtimeRole.replace("qualification.", "") as ModelQualificationCapability;
}

function completedResponse() {
  return {
    version: "model_response_v2",
    text: "ok",
    output: { ok: true },
    toolIntents: [],
    provider: { name: "openrouter", model: "z-ai/glm-test", endpoint: "chat" },
    terminal: { state: "completed", visibleOutputStarted: false, providerTerminalEvent: "chat.completion" },
    validation: { state: "not_requested" },
  } as const;
}

function failedResponse() {
  return {
    ...completedResponse(),
    terminal: { state: "malformed", visibleOutputStarted: false },
    validation: { state: "failed", failureCode: "MODEL_QUALIFICATION_FAILED" },
  } as const;
}

function toolResponse() {
  return {
    ...completedResponse(),
    toolIntents: [{ id: "call-1", name: "probe_tool", input: {} }],
  } as const;
}

function fakeGateway(
  call: (request: ModelRequest) => Promise<unknown>,
): ReturnType<typeof bindModelQualificationGateway> {
  const gateway: ModelGateway = {
    async call<T>(request: ModelRequest): Promise<T> {
      return (await call(request)) as T;
    },
  };
  return bindModelQualificationGateway({
    gateway,
    binding: createModelQualificationBinding({
      registration: registration(),
      credentialRevision: "credential-1",
      probeRevision: "probe-1",
    }),
  });
}

function registration(credentialRevision = "credential-1") {
  const evidence = {
    source: "provider" as const,
    observedRevision: "registration-1",
    observedAt: "2026-08-26T12:00:00.000Z",
    adapterRevision: "adapter-1",
    credentialRevision,
    retainedPayloadHash: `sha256:${"a".repeat(64)}`,
  };
  const declared = { state: "declared" as const, evidence: [evidence] };
  return createModelRegistrationV2({
    version: MODEL_REGISTRATION_V2_VERSION,
    registrationId: "openrouter:z-ai/glm-test:1",
    providerId: "openrouter",
    modelId: "z-ai/glm-test",
    providerConfiguration: {
      version: PROVIDER_RUNTIME_CONFIGURATION_VERSION,
      providerId: "openrouter",
      protocol: "openrouter",
      authentication: { mode: "required", credentialReference: { source: "test", id: "provider.openrouter.default" } },
      endpoint: "https://openrouter.example/api/v1",
      timeoutMs: 1_000,
      allowedHeaders: [],
      dataHandling: "provider_managed",
    },
    route: {
      apiEndpoint: "https://openrouter.example/api/v1",
      endpointCodec: "openrouter_chat_v2",
      routing: { kind: "fixed", policyId: "exact", requireParameters: true },
    },
    revision: "registration-1",
    adapterRevision: "adapter-1",
    credentialRevision,
    providerEvidence: [evidence],
    qualification: { state: "pending" },
    capabilities: {
      jsonSyntax: declared,
      localSchemaValidation: declared,
      providerStrictSchema: declared,
      nativeTools: declared,
      requiredToolChoice: declared,
      strictToolInputs: declared,
      parallelToolCalls: declared,
      reasoning: { ...declared, modes: ["off", "summary", "provider_visible"] },
      continuation: { ...declared, kinds: ["encrypted_content", "signature", "reasoning_details"] },
      streaming: { ...declared, terminalEvents: ["chat.completion"] },
      inputModalities: { text: declared, image: declared },
      limits: { context: { kind: "model_specific" }, output: { kind: "model_specific" }, evidence: [evidence] },
      cache: { ...declared, read: false, write: false, scope: "none" },
    },
  });
}
