import assert from "node:assert/strict";
import test from "node:test";
import {
  createKestrelDefaultEconomicsProfile,
  createGatewayModelEconomicsProfile,
  GATEWAY_MODEL_ECONOMICS_PROFILE_KEY,
  getGatewayModelEconomicsProvider,
  withGatewayModelEconomicsProfile,
} from "./model-economics-profile";

test("Kestrel fallback profile is conservative and disclosed", () => {
  assert.deepEqual(
    createKestrelDefaultEconomicsProfile({ provider: "openai", model: "gpt-4" }),
    {
      version: 1,
      profileId: "openai:gpt-4:v1",
      provider: "openai",
      model: "gpt-4",
      contextWindowTokens: 32_768,
      maxOutputTokens: 8_192,
      counting: {
        counter: "utf8-byte-upper-bound",
        counterVersion: "1",
        method: "conservative_estimate",
        confidence: "conservative",
      },
      cache: { behavior: "none" },
    },
  );
});
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

test("OpenRouter provider capacity takes precedence and permits equal limits", () => {
  const profile = createGatewayModelEconomicsProfile({
    provider: "openrouter",
    model: "z-ai/glm-5.2:free",
    metadata: {
      context_length: 1_000_000,
      top_provider: {
        context_length: 256_000,
        max_completion_tokens: 256_000,
      },
    },
  });

  assert.equal(profile?.contextWindowTokens, 256_000);
  assert.equal(profile?.maxOutputTokens, 256_000);
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

test("backfill planning defers OpenRouter rows to exact live resolution", () => {
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

  assert.equal(plan.repairable, 0);
  assert.deepEqual(plan.skipped, [
    {
      id: "repairable",
      provider: "openrouter",
      model: "z-ai/glm-5.2:free",
      reason: "openrouter_resolution_required",
    },
    {
      id: "unrepairable",
      provider: "openrouter",
      model: "opaque-model",
      reason: "openrouter_resolution_required",
    },
  ]);
});

test("backfill assigns disclosed defaults only to identified non-OpenRouter catalogs", () => {
  const plan = planGatewayModelEconomicsProfileBackfill([
    {
      id: "openai-model",
      organizationId: "org-1",
      gatewayId: "gateway-1",
      rawModelId: "gpt-4",
      modality: "language",
      approved: true,
      metadata: { id: "gpt-4" },
      gatewayProvider: "openai",
    },
  ]);
  assert.equal(plan.updates[0]?.profile.contextWindowTokens, 32_768);
  assert.equal(
    plan.updates[0]?.metadata.kestrelEconomicsProfileSource,
    "kestrel_default",
  );
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

test("runtime provider identity is canonical for Lumi and RunPod profiles", () => {
  assert.equal(
    getGatewayModelEconomicsProvider({
      gatewayProvider: "lumi",
      modality: "language",
      metadata: { protocol: "anthropic" },
    }),
    "anthropic",
  );
  assert.equal(
    getGatewayModelEconomicsProvider({
      gatewayProvider: "lumi",
      modality: "language",
      metadata: { protocol: "openai" },
    }),
    "openai",
  );
  assert.equal(
    getGatewayModelEconomicsProvider({
      gatewayProvider: "runpod",
      modality: "language",
      metadata: {},
    }),
    "openai",
  );
});

test("backfill stores the same canonical provider identity as runtime lookup", () => {
  const plan = planGatewayModelEconomicsProfileBackfill([
    {
      id: "runpod-model",
      organizationId: "org-1",
      gatewayId: "gateway-1",
      rawModelId: "Qwen/Qwen3-32B",
      modality: "language",
      approved: true,
      metadata: { contextWindowTokens: 32_768, maxOutputTokens: 4096 },
      gatewayProvider: "runpod",
    },
    {
      id: "lumi-openai-model",
      organizationId: "org-1",
      gatewayId: "gateway-2",
      rawModelId: "lumi-model",
      modality: "language",
      approved: true,
      metadata: {
        protocol: "openai",
        context_length: 32_768,
        max_output_tokens: 4096,
      },
      gatewayProvider: "lumi",
    },
  ]);

  assert.deepEqual(
    plan.updates.map((update) => update.profile.provider),
    ["openai", "openai"],
  );
});
