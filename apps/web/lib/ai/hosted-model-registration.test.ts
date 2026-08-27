import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostedModelQualificationProjection,
  createHostedModelRegistration,
  hostedModelRegistrationRevision,
  readHostedModelRegistrationState,
  withHostedModelRegistration,
} from "./hosted-model-registration";

function providerConfiguration(
  provider: "openai" | "openrouter" | "anthropic",
) {
  return {
    version: "provider_runtime_configuration_v1" as const,
    providerId: provider,
    protocol:
      provider === "anthropic"
        ? ("anthropic" as const)
        : provider === "openrouter"
          ? ("openrouter" as const)
          : ("openai" as const),
    authentication: {
      mode: "required" as const,
      credentialReference: {
        source: "hosted-gateway",
        id: `provider.${provider}.hosted`,
      },
    },
    endpoint:
      provider === "anthropic"
        ? "https://api.anthropic.com/v1"
        : provider === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : "https://api.openai.com/v1",
    timeoutMs: 15_000,
    allowedHeaders: [],
    dataHandling: "provider_managed" as const,
  };
}

function createRegistration(
  providerEvidence:
    | { provider: "openai"; catalogRecord: Record<string, unknown> }
    | { provider: "openrouter"; details: Record<string, unknown> }
    | { provider: "anthropic"; modelsApiRecord: Record<string, unknown> },
  modelId: string,
) {
  return createHostedModelRegistration({
    registrationId: `hosted:gateway-test:${modelId}`,
    revision: hostedModelRegistrationRevision({
      providerEvidence,
      modelId,
      credentialRevision: "7",
    }),
    observedAt: "2026-08-26T00:00:00.000Z",
    modelId,
    credentialRevision: "7",
    providerConfiguration: providerConfiguration(providerEvidence.provider),
    providerEvidence,
  });
}

test("hosted registration persists exact OpenAI, OpenRouter, and Anthropic declarations", () => {
  const openai = createRegistration(
    { provider: "openai", catalogRecord: { id: "gpt-4.1-mini" } },
    "gpt-4.1-mini",
  );
  assert.equal(openai.registration.providerId, "openai");
  assert.equal(openai.registration.route.endpointCodec, "openai.responses.v2");
  assert.equal(openai.registration.qualification.state, "pending");
  assert.equal(openai.evidence.sourcePayload.id, "gpt-4.1-mini");

  const openrouter = createRegistration(
    {
      provider: "openrouter",
      details: {
        id: "z-ai/glm-5.2:free",
        canonical_slug: "z-ai/glm-5.2-20260616",
        supported_parameters: ["tools", "tool_choice", "structured_outputs"],
        endpoints: [
          {
            id: "provider-a",
            supported_parameters: [
              "tools",
              "tool_choice",
              "structured_outputs",
            ],
          },
        ],
      },
    },
    "z-ai/glm-5.2:free",
  );
  assert.equal(
    openrouter.registration.route.endpointCodec,
    "openrouter.chat.v2",
  );
  assert.deepEqual(openrouter.registration.route.routing, {
    kind: "fixed",
    policyId: "openrouter:z-ai/glm-5.2:free:provider-a",
    allowedEndpointIds: ["provider-a"],
    requireParameters: true,
  });
  assert.equal(
    openrouter.registration.capabilities.providerStrictSchema.state,
    "declared",
  );
  assert.equal(
    openrouter.evidence.sourcePayload.canonicalSlug,
    "z-ai/glm-5.2-20260616",
  );

  const anthropic = createRegistration(
    {
      provider: "anthropic",
      modelsApiRecord: {
        id: "claude-sonnet-test",
        display_name: "Claude Sonnet",
      },
    },
    "claude-sonnet-test",
  );
  assert.equal(anthropic.registration.providerId, "anthropic");
  assert.equal(
    anthropic.registration.route.endpointCodec,
    "anthropic.messages.v2",
  );
  assert.equal(anthropic.evidence.sourcePayload.id, "claude-sonnet-test");
});

test("server registration replaces browser-shaped capability metadata and exposes stale evidence", () => {
  const registration = createRegistration(
    { provider: "openai", catalogRecord: { id: "gpt-4.1-mini" } },
    "gpt-4.1-mini",
  );
  const metadata = withHostedModelRegistration({
    metadata: {
      userNote: "keep this",
      kestrelModelRegistrationV2: { browser: "claim" },
      kestrelModelQualificationProjectionV1: { state: "qualified" },
    },
    ...registration,
  });
  assert.equal(metadata.userNote, "keep this");
  assert.equal(
    (metadata.kestrelModelRegistrationV2 as { fingerprint: string })
      .fingerprint,
    registration.registration.fingerprint,
  );
  assert.equal(
    readHostedModelRegistrationState({
      metadata,
      provider: "openai",
      modelId: "gpt-4.1-mini",
      credentialRevision: "7",
    }),
    "pending",
  );
  assert.equal(
    readHostedModelRegistrationState({
      metadata,
      provider: "openai",
      modelId: "gpt-4.1-mini",
      credentialRevision: "8",
    }),
    "stale",
  );
  assert.equal(
    readHostedModelRegistrationState({
      metadata: { userNote: "legacy" },
      provider: "openai",
      modelId: "gpt-4.1-mini",
      credentialRevision: "7",
    }),
    "legacy_unqualified",
  );
});

test("qualification projections remain bound to their immutable declaration", () => {
  const registration = createRegistration(
    { provider: "openai", catalogRecord: { id: "gpt-4.1-mini" } },
    "gpt-4.1-mini",
  );
  const projection = createHostedModelQualificationProjection({
    registration: registration.registration,
    credentialRevision: "7",
    state: "qualified",
    checkedAt: "2026-08-26T00:01:00.000Z",
    probeRevision: "hosted-probes-v1",
  });
  const metadata = withHostedModelRegistration({
    metadata: {},
    ...registration,
    qualification: projection,
  });
  assert.equal(
    readHostedModelRegistrationState({
      metadata,
      provider: "openai",
      modelId: "gpt-4.1-mini",
      credentialRevision: "7",
    }),
    "qualified",
  );
  assert.throws(
    () =>
      createHostedModelQualificationProjection({
        registration: registration.registration,
        credentialRevision: "8",
        state: "qualified",
      }),
    /credential revision/u,
  );
});

test("Anthropic and OpenRouter evidence reject an exact identity mismatch", () => {
  assert.throws(
    () =>
      createRegistration(
        { provider: "anthropic", modelsApiRecord: { id: "claude-other" } },
        "claude-sonnet-test",
      ),
    /does not match/u,
  );
  assert.throws(
    () =>
      createRegistration(
        {
          provider: "openrouter",
          details: {
            id: "z-ai/other",
            supported_parameters: [],
            endpoints: [],
          },
        },
        "z-ai/glm-5.2",
      ),
    /Approve the exact returned model ID/u,
  );
});
