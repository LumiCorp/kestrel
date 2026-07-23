import {
  buildModelRequestEconomicsManifest,
  createEconomicsRunEvent,
  hashHarnessEfficiencyValue,
} from "../../src/economics/index.js";

const ECONOMICS_CONTROL = {
  version: 1 as const,
  policy: {
    version: 1 as const,
    policyId: "economics:fixture:v1",
    mode: "observe" as const,
    counting: { estimatorVersion: "utf8-byte-upper-bound:v1", allowEstimatedEnforcement: false },
    context: { outputReserveTokens: 1_000, safetyReserveTokens: 250, sections: [] },
    compaction: { requireStructuredAnchors: true as const, maxSummaryAttempts: 1 as const },
    tools: { exposure: "assembly_allowlist" as const, modelContextMaxTokens: 20_000, allowedFamiliesByPhase: {} },
    cache: { mode: "provider_default" as const },
  },
  modelProfiles: [{
    version: 1 as const,
    profileId: "openrouter:model-a:v1",
    provider: "openrouter",
    model: "model-a",
    contextWindowTokens: 100_000,
    maxOutputTokens: 8_000,
    counting: { counter: "tiktoken:o200k_base", counterVersion: "1.0.21", method: "model_tokenizer" as const, confidence: "model_compatible" as const },
    cache: { behavior: "provider_automatic" as const },
  }],
};

export function economicsReplayBundleFixture(
  runId = "run-economics-fixture",
  sessionId = "session-economics-fixture",
): Record<string, unknown> {
  return {
    version: "runtime_replay_bundle_v1",
    replay: {
      events: [
        createEconomicsRunEvent({
          runId,
          sessionId,
          timestamp: "2026-07-22T00:00:00.000Z",
          event: {
            kind: "model_call.requested",
            cache: { mode: "provider_default", stablePrefixHash: "c".repeat(64), stablePrefixTokens: 0, prefixChanged: false },
            callId: "call-economics-fixture",
            providerPayloadHash: "a".repeat(64),
            componentHash: "b".repeat(64),
            provider: "openrouter",
            model: "model-a",
            modelProfileId: "openrouter:model-a:v1",
            economicsControlHash: hashHarnessEfficiencyValue(ECONOMICS_CONTROL),
            economicsControl: ECONOMICS_CONTROL,
            modelBudgetClass: "action",
            phase: "agent.loop",
            requestManifest: buildModelRequestEconomicsManifest({ request: { input: "fixture", messages: [] } }),
          },
        }),
        createEconomicsRunEvent({
          runId,
          sessionId,
          timestamp: "2026-07-22T00:00:00.010Z",
          event: {
            kind: "model_attempt.started",
            callId: "call-economics-fixture",
            attempt: 1,
            maxAttempts: 1,
            provider: "openrouter",
            model: "model-a",
          },
        }),
        createEconomicsRunEvent({
          runId,
          sessionId,
          timestamp: "2026-07-22T00:00:00.020Z",
          event: { kind: "model_attempt.completed", callId: "call-economics-fixture", attempt: 1, latencyMs: 10 },
        }),
        createEconomicsRunEvent({
          runId,
          sessionId,
          timestamp: "2026-07-22T00:00:00.030Z",
          event: {
            kind: "model_call.completed",
            providerReportedInputDeltaTokens: 0,
            callId: "call-economics-fixture",
            provider: "openrouter",
            model: "model-a",
            latencyMs: 30,
            usage: {
              version: 1,
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              reasoningTokens: 0,
            },
            pricing: { version: 1, status: "priced", currency: "USD", priceVersion: "fixture:v1", sourceUrl: "https://example.test/pricing", totalCostUsd: 0, components: [] },
          },
        }),
      ],
    },
  };
}
