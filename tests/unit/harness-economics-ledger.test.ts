import assert from "node:assert/strict";

import {
  attributeModelCallPrice,
  buildModelRequestEconomicsManifest,
  buildToolResultEconomicsManifest,
  createEconomicsRunEvent,
  normalizeEconomicsUsage,
  projectEconomicsLedger,
  type ModelEconomicsProfileV1,
} from "../../src/economics/index.js";
import { buildAgentToolSuccessResult } from "../../tools/toolResult.js";
import type { RunEvent } from "../../src/kestrel/contracts/events.js";
import { contractTest } from "../helpers/contract-test.js";

const PROFILE: ModelEconomicsProfileV1 = {
  version: 1,
  profileId: "model:test:v1",
  provider: "provider-a",
  model: "model-a",
  contextWindowTokens: 100_000,
  maxOutputTokens: 10_000,
  counting: {
    counter: "counter-a",
    counterVersion: "1",
    method: "exact",
    confidence: "exact",
  },
  price: {
    version: 1,
    priceVersion: "price:test:2026-07-22",
    currency: "USD",
    effectiveAt: "2026-07-22T00:00:00.000Z",
    retrievedAt: "2026-07-22T00:00:00.000Z",
    sourceUrl: "https://provider.example/pricing",
    perMillionTokens: {
      input: 10,
      output: 20,
      cachedInput: 2,
      cacheWrite: 12,
      reasoning: 25,
    },
  },
};

contractTest("runtime.hermetic", "economics pricing preserves cache and reasoning attribution without double counting", () => {
  const usage = normalizeEconomicsUsage({
    inputTokens: 1_000,
    outputTokens: 500,
    totalTokens: 1_500,
    cachedInputTokens: 200,
    cacheWriteInputTokens: 100,
    reasoningTokens: 50,
  });
  const pricing = attributeModelCallPrice({
    usage,
    profile: PROFILE,
    provider: "provider-a",
    model: "model-a",
  });

  assert.equal(pricing.status, "priced");
  if (pricing.status !== "priced") return;
  assert.deepEqual(pricing.components.map((entry) => [entry.category, entry.tokens]), [
    ["input", 700],
    ["output", 450],
    ["cached_input", 200],
    ["cache_write", 100],
    ["reasoning", 50],
  ]);
  assert.equal(pricing.priceVersion, "price:test:2026-07-22");
  assert.equal(Math.abs(pricing.totalCostUsd - 0.01885) < 1e-12, true);
});

contractTest("runtime.hermetic", "append-only economics events replay into one call attempt and independent outcome", () => {
  const usage = normalizeEconomicsUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  const events: RunEvent[] = [
    event("2026-07-22T10:00:00.000Z", {
      kind: "model_call.requested",
      callId: "call-1",
      providerPayloadHash: "payload-hash",
      componentHash: "component-hash",
      provider: "provider-a",
      model: "model-a",
      modelBudgetClass: "action",
      phase: "agent",
      contextPolicyId: "context-policy:test",
      requestManifest: buildModelRequestEconomicsManifest({ request: { input: "test", messages: [] } }),
    }),
    event("2026-07-22T10:00:00.010Z", {
      kind: "model_attempt.started",
      callId: "call-1",
      attempt: 1,
      maxAttempts: 3,
      provider: "provider-a",
      model: "model-a",
    }),
    event("2026-07-22T10:00:00.100Z", {
      kind: "model_attempt.completed",
      callId: "call-1",
      attempt: 1,
      latencyMs: 90,
    }),
    event("2026-07-22T10:00:00.110Z", {
      kind: "model_call.completed",
      callId: "call-1",
      provider: "provider-a",
      model: "model-a",
      latencyMs: 110,
      usage,
      pricing: attributeModelCallPrice({ usage, profile: PROFILE, provider: "provider-a", model: "model-a" }),
    }),
    event("2026-07-22T10:00:01.000Z", {
      kind: "outcome.evaluated",
      callId: "call-1",
      evaluatorId: "acceptance-verifier",
      evaluatorVersion: "1",
      acceptance: "accepted",
      independentlyEvaluated: true,
    }),
  ];

  const projection = projectEconomicsLedger(events);

  assert.equal(projection.invalidEvents.length, 0);
  assert.equal(projection.calls[0]?.request?.contextPolicyId, "context-policy:test");
  assert.equal(projection.calls[0]?.attempts[0]?.latencyMs, 90);
  assert.equal(projection.totals.calls, 1);
  assert.equal(projection.totals.attempts, 1);
  assert.equal(projection.totals.independentlyAcceptedCalls, 1);
  assert.equal(projection.totals.unpricedCalls, 0);
});

contractTest("runtime.hermetic", "economics replay reports mutated event payloads instead of trusting them", () => {
  const runEvent = event("2026-07-22T10:00:00.000Z", {
    kind: "model_attempt.started",
    callId: "call-1",
    attempt: 1,
    maxAttempts: 3,
  });
  const tampered: RunEvent = {
    ...runEvent,
    metadata: { ...runEvent.metadata, maxAttempts: 99 },
  };

  const projection = projectEconomicsLedger([tampered]);

  assert.equal(projection.calls.length, 0);
  assert.match(projection.invalidEvents[0]?.reason ?? "", /payload hash does not match/u);
});

contractTest("runtime.hermetic", "economics replay keeps tool result reduction separate from model calls", () => {
  const result = buildAgentToolSuccessResult({
    toolName: "fs.read_text",
    input: { path: "large.txt" },
    output: { content: "evidence".repeat(20_000) },
  });
  const runEvent = event("2026-07-22T10:00:00.000Z", {
    kind: "tool_result.recorded",
    callId: "tool-1",
    toolCallId: "tool-1",
    toolName: "fs.read_text",
    status: "OK",
    latencyMs: 25,
    resultManifest: buildToolResultEconomicsManifest(result),
  });

  const projection = projectEconomicsLedger([runEvent]);

  assert.equal(projection.invalidEvents.length, 0);
  assert.equal(projection.calls.length, 0);
  assert.equal(projection.toolResults.length, 1);
  assert.equal(projection.totals.toolResults, 1);
  assert.ok(projection.totals.reducedToolResultTokens > 0);
});

function event(
  timestamp: string,
  draft: Parameters<typeof createEconomicsRunEvent>[0]["event"],
): RunEvent {
  return createEconomicsRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    stepIndex: 0,
    timestamp,
    event: draft,
  });
}
