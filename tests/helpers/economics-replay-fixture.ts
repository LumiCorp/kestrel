import {
  buildModelRequestEconomicsManifest,
  createEconomicsRunEvent,
} from "../../src/economics/index.js";

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
            callId: "call-economics-fixture",
            providerPayloadHash: "a".repeat(64),
            componentHash: "b".repeat(64),
            provider: "openrouter",
            model: "model-a",
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
            pricing: { version: 1, status: "unpriced", reason: "price_unavailable" },
          },
        }),
      ],
    },
  };
}
