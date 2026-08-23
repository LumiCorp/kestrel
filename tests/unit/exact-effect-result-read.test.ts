import assert from "node:assert/strict";
import test from "node:test";

import { SandboxCapabilityExactResultCancelledError, validateExactEffectResultRead, validateExactEffectResultTenantBinding, type PersistedEffect } from "../../src/kestrel/contracts/store.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import { createTestToolGateway, prepareTestToolCall } from "../helpers/createTestToolGateway.js";

const timestamp = "2026-08-23T12:00:00.000Z";
const requested = { sessionId: "session-1", runId: "run-1", idempotencyKey: "call-1" };
const gateway = createTestToolGateway({ "code.execute": async () => ({ status: "ok" }) });
const preparedToolCall = await prepareTestToolCall({
  gateway,
  toolName: "code.execute",
  toolInput: { language: "javascript", code: "console.log('ok')" },
  runId: requested.runId,
  sessionId: requested.sessionId,
  callId: requested.idempotencyKey,
});
const activation = preparedToolCall.activation;
const effect: PersistedEffect = {
  runId: requested.runId,
  sessionId: requested.sessionId,
  stepIndex: 1,
  type: "execute_tool_call",
  payload: { preparedToolCall },
  idempotencyKey: requested.idempotencyKey,
  failurePolicy: "STOP",
  status: "DONE",
  createdAt: timestamp,
};
const result = {
  version: "v2" as const,
  toolName: "code.execute",
  status: "OK" as const,
  toolCallId: requested.idempotencyKey,
  activation,
  outcome: {
    version: "v1" as const,
    callId: requested.idempotencyKey,
    activation,
    kind: "success" as const,
    startedAt: timestamp,
    completedAt: timestamp,
    effectState: "not_applicable" as const,
    rawOutput: { status: "ok", capabilityReplayEvidence: { version: 1, leaseId: "lease-1", bindingDigest: "a".repeat(64), toolCallId: requested.idempotencyKey } },
  },
  modelContext: { text: "ok", rawOutputRef: "sha256:result", truncated: false },
  auditRecord: {
    toolName: "code.execute",
    input: preparedToolCall.effectiveInput,
    output: { status: "ok" },
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    status: "OK" as const,
  },
};
const effectResult = { idempotencyKey: requested.idempotencyKey, status: "DONE" as const, output: result, timestamp };

test("exact effect result reads fail closed for absent, incomplete, and conflicting durable evidence", () => {
  assert.deepEqual(validateExactEffectResultRead({ requested, effect: null, effectResult: null }), { status: "not_found" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect: { ...effect, status: "PENDING" }, effectResult: null }), { status: "incomplete" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect, effectResult: { ...effectResult, status: "FAILED", output: undefined } }), { status: "incomplete" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect: { ...effect, sessionId: "other-session" }, effectResult }), { status: "not_found" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect: { ...effect, payload: { preparedToolCall: { ...preparedToolCall, callId: "other-call" } } }, effectResult }), { status: "conflict" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect, effectResult: { ...effectResult, output: { ...result, toolCallId: "other-call" } } }), { status: "conflict" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect, effectResult: { ...effectResult, output: { ...result, toolName: "other.tool" } } }), { status: "conflict" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect, effectResult: { ...effectResult, output: { ...result, activation: { ...activation, registryGeneration: "other-generation" }, outcome: { ...result.outcome, activation: { ...activation, registryGeneration: "other-generation" } } } } }), { status: "conflict" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect, effectResult: { ...effectResult, output: { ...result, outcome: { ...result.outcome, activation: { ...activation, registryGeneration: "other-outcome-generation" } } } } }), { status: "conflict" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect, effectResult: { ...effectResult, output: { ...result, auditRecord: { ...result.auditRecord, input: { other: true } } } } }), { status: "conflict" });
});

test("exact effect result reads return the complete persisted AgentToolResult only on exact identity", () => {
  assert.deepEqual(validateExactEffectResultRead({ requested, effect, effectResult }), { status: "found", result });
});

test("in-memory exact completion and cancellation claims have a single durable winner", async () => {
  const cancellationWins = new InMemorySessionStore();
  (cancellationWins as unknown as { effects: PersistedEffect[] }).effects.push({ ...effect, status: "PENDING" });
  assert.deepEqual(await cancellationWins.claimExactEffectCancellation({ ...requested, tenantId: "tenant-1" }), { status: "cancelled" });
  await assert.rejects(cancellationWins.saveSandboxCapabilityEffectResult({
    leaseId: "lease-1",
    bindingDigest: "a".repeat(64),
    toolCallId: requested.idempotencyKey,
    runId: requested.runId,
    sessionId: requested.sessionId,
    result: effectResult,
  }), SandboxCapabilityExactResultCancelledError);

  const completionWins = new InMemorySessionStore();
  (completionWins as unknown as { effects: PersistedEffect[] }).effects.push({ ...effect, status: "PENDING" });
  await completionWins.saveEffectResult(requested.runId, requested.sessionId, effectResult);
  assert.deepEqual(await completionWins.claimExactEffectCancellation({ ...requested, tenantId: "tenant-1" }), { status: "completed" });
  assert.equal((await completionWins.getPersistedEffect(requested.idempotencyKey))?.status, "PENDING");
});

test("exact effect result reads bind the persisted capability lease to trusted tenant authority", () => {
  const found = validateExactEffectResultRead({ requested, effect, effectResult });
  const lease = { leaseId: "lease-1", binding: { tenantId: "tenant-1", sessionId: requested.sessionId, runId: requested.runId, toolCallId: requested.idempotencyKey } } as never;
  assert.deepEqual(validateExactEffectResultTenantBinding({ read: found, requested: { ...requested, tenantId: "tenant-1" }, lease }), found);
  assert.deepEqual(validateExactEffectResultTenantBinding({ read: found, requested: { ...requested, tenantId: "tenant-2" }, lease }), { status: "not_found" });
  assert.deepEqual(validateExactEffectResultTenantBinding({ read: found, requested: { ...requested, tenantId: "tenant-1" }, lease: null }), { status: "conflict" });
});
