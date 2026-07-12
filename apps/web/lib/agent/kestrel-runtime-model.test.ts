import assert from "node:assert/strict";
import test from "node:test";
import {
  applyKestrelOneModelToProfile,
  toKestrelOneRuntimeModelSelection,
} from "./kestrel-runtime-model";

test("approved native gateway models become runner model selections", () => {
  assert.deepEqual(
    toKestrelOneRuntimeModelSelection({
      id: "preferred-model",
      gatewayId: "gateway-openrouter",
      rawModelId: "openai/gpt-5.4",
      gatewayProvider: "openrouter",
    }),
    {
      id: "preferred-model",
      gatewayId: "gateway-openrouter",
      model: "openai/gpt-5.4",
      provider: "openrouter",
    }
  );
});

test("runtime model selection preserves the base profile contract", () => {
  const profile = applyKestrelOneModelToProfile(
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
    {
      id: "preferred-model",
      gatewayId: "gateway-openai",
      model: "gpt-5.4",
      provider: "openai",
    }
  );

  assert.equal(profile.id, "kestrel-one:model:preferred-model");
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
    gatewayId: "gateway-openai",
    rawModelId: "gpt-5.4",
  });
  assert.equal(JSON.stringify(profile).includes("provider-secret"), false);
  assert.deepEqual(profile.toolAllowlist, [
    "kestrel_one.search_knowledge_documents",
  ]);
  assert.deepEqual(profile.guardrails, { maxStepVisits: 80 });
});

test("Lumi models select the configured native runner protocol", () => {
  assert.equal(
    toKestrelOneRuntimeModelSelection({
      id: "lumi-model",
      gatewayId: "gateway-lumi",
      rawModelId: "claude-sonnet",
      gatewayProvider: "lumi",
      metadata: { protocol: "anthropic" },
    }).provider,
    "anthropic"
  );
});
