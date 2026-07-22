import assert from "node:assert/strict";
import {
  applyKestrelOneModelToProfile,
  toKestrelOneRuntimeModelSelection,
} from "./kestrel-runtime-model";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "approved native gateway models become runner model selections", () => {
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

contractTest("web.hermetic", "runtime model selection preserves the base profile contract", () => {
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
      organizationId: "org-1",
      environmentId: "env-1",
      model: "gpt-5.4",
      provider: "openai",
    },
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

contractTest("web.hermetic", "Lumi models select the configured native runner protocol", () => {
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

contractTest("web.hermetic", "RunPod models use the OpenAI runner protocol with a gateway credential reference", () => {
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
