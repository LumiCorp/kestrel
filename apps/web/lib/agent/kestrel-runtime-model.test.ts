import test from "node:test";
import assert from "node:assert/strict";
import {
  applyKestrelOneModelsToProfile,
  toKestrelOneRuntimeModelSelection,
} from "./kestrel-runtime-model";
import { translateOpenAiManifestModel } from "../../../../models/openai/OpenAiModelManifest";
import { createModelRegistrationV2 } from "../../../../src/kestrel/contracts/model-registration";


test("eligible native gateway models become runner model selections", () => {
  assert.deepEqual(
    toKestrelOneRuntimeModelSelection({
      id: "preferred-model",
      gatewayId: "gateway-openrouter",
      rawModelId: "openai/gpt-5.4",
      gatewayProvider: "openrouter",
      metadata: {
        context_length: 128_000,
        top_provider: { max_completion_tokens: 16_000 },
      },
      organizationId: "org-1",
      environmentId: "env-1",
    }),
    {
      id: "preferred-model",
      gatewayId: "gateway-openrouter",
      organizationId: "org-1",
      environmentId: "env-1",
      model: "openai/gpt-5.4",
      provider: "openrouter",
      economicsProfile: {
        version: 1,
        profileId: "openrouter:openai/gpt-5.4:v1",
        provider: "openrouter",
        model: "openai/gpt-5.4",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        counting: { counter: "utf8-byte-upper-bound", counterVersion: "1", method: "conservative_estimate", confidence: "conservative" },
        cache: { behavior: "none" },
      },
    }
  );
});

test("hosted models without an exact economics profile are rejected locally", () => {
  assert.throws(
    () =>
      toKestrelOneRuntimeModelSelection({
        id: "missing-profile",
        gatewayId: "gateway-openrouter",
        rawModelId: "openai/gpt-5.4",
        gatewayProvider: "openrouter",
        organizationId: "org-1",
        environmentId: "env-1",
      }),
    (error: unknown) =>
      (error as { code?: string }).code === "GATEWAY_MODEL_RUNTIME_INELIGIBLE",
  );
});

test("approved model metadata carries its economics profile into selection", () => {
  const selection = toKestrelOneRuntimeModelSelection({
    id: "glm-free",
    gatewayId: "gateway-openrouter",
    rawModelId: "z-ai/glm-5.2:free",
    gatewayProvider: "openrouter",
    metadata: {
      kestrelEconomicsProfile: {
        version: 1,
        profileId: "openrouter:z-ai/glm-5.2:free:v1",
        provider: "openrouter",
        model: "z-ai/glm-5.2:free",
        contextWindowTokens: 202_752,
        maxOutputTokens: 65_536,
        counting: {
          counter: "utf8-byte-upper-bound",
          counterVersion: "1",
          method: "conservative_estimate",
          confidence: "conservative",
        },
        cache: { behavior: "none" },
      },
    },
    organizationId: "org-1",
    environmentId: "env-1",
  });
  assert.equal(selection.economicsProfile?.model, "z-ai/glm-5.2:free");
});

test("legacy approved catalog metadata is upgraded at runtime", () => {
  const selection = toKestrelOneRuntimeModelSelection({
    id: "legacy-glm-free",
    gatewayId: "gateway-openrouter",
    rawModelId: "z-ai/glm-5.2:free",
    gatewayProvider: "openrouter",
    metadata: {
      context_length: 202_752,
      top_provider: { max_completion_tokens: 65_536 },
    },
    organizationId: "org-1",
    environmentId: "env-1",
  });
  assert.equal(selection.economicsProfile?.contextWindowTokens, 202_752);
});

test("qualified hosted selections carry their exact registration into the runner profile", () => {
  const pending = translateOpenAiManifestModel({
    registrationId: "openai:gpt-4.1-mini:responses",
    revision: "catalog-1",
    modelId: "gpt-4.1-mini",
    endpoint: "responses",
    credentialRevision: "7",
    providerConfiguration: {
      version: "provider_runtime_configuration_v1",
      providerId: "openai",
      protocol: "openai",
      authentication: {
        mode: "required",
        credentialReference: { source: "gateway", id: "provider.openai.default" },
      },
      endpoint: "https://api.openai.com/v1",
      timeoutMs: 60_000,
      allowedHeaders: [],
      dataHandling: "provider_managed",
    },
  });
  const { fingerprint: _fingerprint, ...authoring } = pending;
  const registration = createModelRegistrationV2({
    ...authoring,
    qualification: {
      state: "qualified",
      revision: "qualification-1",
      checkedAt: "2026-08-26T12:00:00.000Z",
      probeHash: `sha256:${"a".repeat(64)}`,
    },
  });
  const selection = toKestrelOneRuntimeModelSelection({
    id: "qualified-openai",
    gatewayId: "gateway-openai",
    rawModelId: "gpt-4.1-mini",
    gatewayProvider: "openai",
    credentialRevision: 7,
    metadata: {
      kestrelModelRegistrationV2: registration,
      kestrelEconomicsProfile: {
        version: 1,
        profileId: "openai:gpt-4.1-mini:v1",
        provider: "openai",
        model: "gpt-4.1-mini",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        counting: { counter: "utf8-byte-upper-bound", counterVersion: "1", method: "conservative_estimate", confidence: "conservative" },
        cache: { behavior: "none" },
      },
    },
    organizationId: "org-1",
    environmentId: "env-1",
  });
  const profile = applyKestrelOneModelsToProfile(
    { id: "base", label: "Base", agent: "reference-react", sessionPrefix: "base" },
    [selection],
    "run-qualified",
  );

  assert.equal(selection.registration?.fingerprint, registration.fingerprint);
  assert.equal(profile.modelCredential?.registration?.fingerprint, registration.fingerprint);
  assert.equal(profile.modelCredential?.routeBinding?.status, "qualified");
});

test("runtime model selection preserves the base profile contract", () => {
  const profile = applyKestrelOneModelsToProfile(
    {
      id: "kestrel-one",
      label: "Kestrel One",
      agent: "reference-react",
      sessionPrefix: "kestrel-one",
      toolAllowlist: ["kestrel_one.search_knowledge_documents"],
      guardrails: { maxStepVisits: 80 },
      agentStageConfig: {
        modelByStage: {
          "agent.loop": "z-ai/glm-5.2",
          "future.stage": "preserve-me",
        },
        preservedSetting: true,
      },
    },
    [
      {
        id: "preferred-model",
        gatewayId: "gateway-openai",
        organizationId: "org-1",
        environmentId: "env-1",
        model: "gpt-5.4",
        provider: "openai",
      },
    ],
    "run-1"
  );

  assert.equal(
    profile.id,
    "kestrel-one:model:preferred-model:run:run-1"
  );
  assert.equal(profile.modelProvider, "openai");
  assert.equal(profile.model, "gpt-5.4");
  assert.deepEqual(profile.agentStageConfig, {
    modelByStage: {
      "agent.loop": "gpt-5.4",
      "future.stage": "preserve-me",
    },
    preservedSetting: true,
  });
  assert.deepEqual(profile.modelCredential, {
    source: "kestrel-one",
    runId: "run-1",
    gatewayId: "gateway-openai",
    organizationId: "org-1",
    environmentId: "env-1",
    rawModelId: "gpt-5.4",
    provider: "openai",
    routeBinding: {
      version: "model_credential_route_binding_v2",
      status: "legacy_unqualified",
      provider: "openai",
      rawModelId: "gpt-5.4",
    },
  });
  assert.equal(JSON.stringify(profile).includes("provider-secret"), false);
  assert.deepEqual(profile.toolAllowlist, [
    "kestrel_one.search_knowledge_documents",
  ]);
  assert.deepEqual(profile.guardrails, { maxStepVisits: 80 });
});

test("Desktop-local model selection never carries a Kestrel One credential reference", () => {
  const profile = applyKestrelOneModelsToProfile(
    {
      id: "base",
      label: "Base",
      agent: "reference-react",
      sessionPrefix: "base",
      modelCredential: {
        source: "kestrel-one",
        runId: "prior",
        gatewayId: "prior",
        organizationId: "org",
        environmentId: "env",
        rawModelId: "prior",
        provider: "openai",
      },
    },
    [
      {
        desktopLocal: true,
        id: "desktop-local:ollama:qwen",
        organizationId: "org",
        environmentId: "env",
        provider: "ollama",
        model: "qwen",
      },
    ],
    "run-1",
  );
  assert.equal(profile.modelProvider, "ollama");
  assert.equal(profile.model, "qwen");
  assert.equal(profile.modelCredential, undefined);
});

test("direct local model selection uses runner environment credentials", () => {
  const profile = applyKestrelOneModelsToProfile(
    {
      id: "base",
      label: "Base",
      agent: "reference-react",
      sessionPrefix: "base",
    },
    [
      {
        directLocal: true,
        id: "openrouter:gpt-5-nano",
        organizationId: "org",
        environmentId: "env",
        provider: "openrouter",
        model: "openai/gpt-5-nano",
      },
    ],
    "run-1",
  );
  assert.equal(profile.modelProvider, "openrouter");
  assert.equal(profile.model, "openai/gpt-5-nano");
  assert.equal(profile.modelCredential, undefined);
});

test("ordered runtime models select only the explicit primary route", () => {
  const profile = applyKestrelOneModelsToProfile(
    {
      id: "kestrel-one",
      label: "Kestrel One",
      agent: "reference-react",
      sessionPrefix: "kestrel-one",
    },
    [
      {
        id: "primary",
        gatewayId: "gateway-primary",
        organizationId: "org-1",
        environmentId: "env-1",
        model: "gpt-5.4",
        provider: "openai",
      },
      {
        id: "fallback",
        gatewayId: "gateway-fallback",
        organizationId: "org-1",
        environmentId: "env-1",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
      },
    ],
    "run-1",
  );

  assert.equal(profile.modelProvider, "openai");
  assert.equal(profile.model, "gpt-5.4");
  assert.equal(
    (profile.modelCredential as { gatewayId?: string } | undefined)?.gatewayId,
    "gateway-primary",
  );
  assert.equal("recoveryModelCandidates" in profile, false);
});

test("Lumi models select the configured native runner protocol", () => {
  assert.equal(
    toKestrelOneRuntimeModelSelection({
      id: "lumi-model",
      gatewayId: "gateway-lumi",
      rawModelId: "claude-sonnet",
      gatewayProvider: "lumi",
      metadata: {
        protocol: "anthropic",
        max_input_tokens: 200_000,
        max_output_tokens: 8_192,
      },
      organizationId: "org-1",
      environmentId: "env-1",
    }).provider,
    "anthropic"
  );
});

test("RunPod models use the OpenAI runner protocol with a gateway credential reference", () => {
  assert.deepEqual(
    toKestrelOneRuntimeModelSelection({
      id: "runpod-model",
      gatewayId: "gateway-runpod",
      rawModelId: "Qwen/Qwen3-32B",
      gatewayProvider: "runpod",
      metadata: {
        contextWindowTokens: 32_768,
        maxOutputTokens: 8_192,
      },
      organizationId: "org-1",
      environmentId: "env-1",
    }),
    {
      id: "runpod-model",
      gatewayId: "gateway-runpod",
      organizationId: "org-1",
      environmentId: "env-1",
      model: "Qwen/Qwen3-32B",
      provider: "openai",
      economicsProfile: {
        version: 1,
        profileId: "openai:Qwen/Qwen3-32B:v1",
        provider: "openai",
        model: "Qwen/Qwen3-32B",
        contextWindowTokens: 32_768,
        maxOutputTokens: 8_192,
        counting: { counter: "utf8-byte-upper-bound", counterVersion: "1", method: "conservative_estimate", confidence: "conservative" },
        cache: { behavior: "none" },
      },
    }
  );
});
