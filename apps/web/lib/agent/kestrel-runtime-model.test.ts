import test from "node:test";
import assert from "node:assert/strict";
import {
  applyKestrelOneModelsToProfile,
  toKestrelOneRuntimeModelSelection,
} from "./kestrel-runtime-model";


test("approved native gateway models become runner model selections", () => {
  assert.deepEqual(
    toKestrelOneRuntimeModelSelection({
      id: "preferred-model",
      gatewayId: "gateway-openrouter",
      rawModelId: "openai/gpt-5.4",
      gatewayProvider: "openrouter",
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
    }
  );
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

test("ordered runtime model candidates retain exact per-route credential bindings", () => {
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

  assert.deepEqual(profile.recoveryModelCandidates, [
    {
      candidateId: "fallback.1.fallback",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      capabilities: {
        visionInputEnabled: false,
        toolCallingEnabled: true,
        structuredOutputEnabled: true,
        reasoningModes: ["off", "summary", "provider_visible"],
      },
      credentialReference: {
        source: "kestrel-one",
        runId: "run-1",
        gatewayId: "gateway-fallback",
        organizationId: "org-1",
        environmentId: "env-1",
        rawModelId: "claude-sonnet-4-5",
        provider: "anthropic",
      },
    },
  ]);
});

test("Lumi models select the configured native runner protocol", () => {
  assert.equal(
    toKestrelOneRuntimeModelSelection({
      id: "lumi-model",
      gatewayId: "gateway-lumi",
      rawModelId: "claude-sonnet",
      gatewayProvider: "lumi",
      metadata: { protocol: "anthropic" },
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
    }
  );
});
