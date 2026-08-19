import assert from "node:assert/strict";
import test from "node:test";
import {
  createGatewayModelEconomicsProfile,
  GATEWAY_MODEL_ECONOMICS_PROFILE_KEY,
  withGatewayModelEconomicsProfile,
} from "./model-economics-profile";
import { planGatewayModelEconomicsProfileBackfill } from "./model-economics-profile-backfill";

test("approved OpenRouter catalog models receive an exact economics profile", () => {
  const profile = createGatewayModelEconomicsProfile({
    provider: "openrouter",
    model: "z-ai/glm-5.2:free",
    metadata: {
      context_length: 202_752,
      top_provider: { max_completion_tokens: 65_536 },
    },
  });

  assert.deepEqual(profile, {
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
  });
});

test("model approval persists and unapproval removes the economics profile", () => {
  const approved = withGatewayModelEconomicsProfile({
    provider: "openrouter",
    model: "openai/gpt-5.6-luna",
    modality: "language",
    approved: true,
    metadata: { context_length: 1_050_000, max_output_tokens: 128_000 },
  });
  assert.ok(approved);
  assert.equal(
    (approved[GATEWAY_MODEL_ECONOMICS_PROFILE_KEY] as { model: string }).model,
    "openai/gpt-5.6-luna",
  );

  const unapproved = withGatewayModelEconomicsProfile({
    provider: "openrouter",
    model: "openai/gpt-5.6-luna",
    modality: "language",
    approved: false,
    metadata: approved,
  });
  assert.equal(unapproved?.[GATEWAY_MODEL_ECONOMICS_PROFILE_KEY], undefined);
});

test("existing approved profiles survive an admin metadata edit", () => {
  const profile = {
    version: 1 as const,
    profileId: "openrouter:test:v1",
    provider: "openrouter",
    model: "test",
    contextWindowTokens: 100_000,
    maxOutputTokens: 10_000,
    counting: {
      counter: "utf8-byte-upper-bound",
      counterVersion: "1",
      method: "conservative_estimate" as const,
      confidence: "conservative" as const,
    },
    cache: { behavior: "none" as const },
  };
  const metadata = withGatewayModelEconomicsProfile({
    provider: "openrouter",
    model: "test",
    modality: "language",
    approved: true,
    metadata: { [GATEWAY_MODEL_ECONOMICS_PROFILE_KEY]: profile },
  });
  assert.deepEqual(metadata?.[GATEWAY_MODEL_ECONOMICS_PROFILE_KEY], profile);
});

test("invalid approved profiles are replaced when catalog capacity is available", () => {
  const metadata = withGatewayModelEconomicsProfile({
    metadata: {
      context_length: 128_000,
      top_provider: { max_completion_tokens: 16_000 },
      [GATEWAY_MODEL_ECONOMICS_PROFILE_KEY]: {
        version: 1,
        provider: "openrouter",
        model: "old-model",
      },
    },
    provider: "openrouter",
    model: "new-model",
    approved: true,
    modality: "language",
  });

  assert.equal(
    (metadata?.[GATEWAY_MODEL_ECONOMICS_PROFILE_KEY] as { model: string })
      .model,
    "new-model",
  );
});

test("backfill planning repairs catalog models and reports missing capacity", () => {
  const plan = planGatewayModelEconomicsProfileBackfill([
    {
      id: "repairable",
      organizationId: "org-1",
      gatewayId: "gateway-1",
      rawModelId: "z-ai/glm-5.2:free",
      modality: "language",
      approved: true,
      metadata: {
        context_length: 202_752,
        top_provider: { max_completion_tokens: 65_536 },
      },
      gatewayProvider: "openrouter",
    },
    {
      id: "unrepairable",
      organizationId: "org-1",
      gatewayId: "gateway-1",
      rawModelId: "opaque-model",
      modality: "language",
      approved: true,
      metadata: {},
      gatewayProvider: "openrouter",
    },
  ]);

  assert.equal(plan.repairable, 1);
  assert.equal(plan.updates[0]?.profile.model, "z-ai/glm-5.2:free");
  assert.deepEqual(plan.skipped, [
    {
      id: "unrepairable",
      provider: "openrouter",
      model: "opaque-model",
      reason: "missing_capacity_metadata",
    },
  ]);
});

test("provider catalog field variants cover Lumi and RunPod OpenAI-compatible metadata", () => {
  assert.equal(
    createGatewayModelEconomicsProfile({
      provider: "anthropic",
      model: "claude-sonnet",
      metadata: {
        protocol: "anthropic",
        max_input_tokens: 200_000,
        max_output_tokens: 8192,
      },
    })?.provider,
    "anthropic",
  );
  assert.equal(
    createGatewayModelEconomicsProfile({
      provider: "runpod",
      model: "Qwen/Qwen3-32B",
      metadata: {
        contextWindowTokens: 32_768,
        maxOutputTokens: 4096,
      },
    })?.maxOutputTokens,
    4096,
  );
});
