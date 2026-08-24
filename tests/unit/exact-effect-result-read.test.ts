import assert from "node:assert/strict";
import test from "node:test";

import {
  fingerprintSandboxCapabilityLeaseBindingV1,
  TAVILY_SEARCH_CAPABILITY_ID,
  TAVILY_SEARCH_OPERATION,
  TAVILY_SEARCH_RESOURCE,
} from "../../src/kestrel/contracts/sandbox-capability.js";
import { SandboxCapabilityExactResultCancelledError, validateExactEffectResultRead, validateExactEffectResultTenantBinding, type PersistedEffect } from "../../src/kestrel/contracts/store.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import { createTestToolGateway, prepareTestToolCall } from "../helpers/createTestToolGateway.js";

const timestamp = "2026-08-23T12:00:00.000Z";
const requested = { sessionId: "session-1", runId: "run-1", idempotencyKey: "call-1" };
const gateway = createTestToolGateway({ "code.execute": async () => ({ status: "ok" }) });
const preparedToolCall = await prepareTestToolCall({
  gateway,
  toolName: "code.execute",
  toolInput: {
    language: "javascript",
    code: "console.log('ok')",
    capability: { capabilityId: "tavily.search.read", input: { query: "ok" } },
  },
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
const leaseBinding = {
  version: 1 as const,
  tenantId: "tenant-1",
  environmentId: "environment-1",
  sessionId: requested.sessionId,
  runId: requested.runId,
  toolCallId: requested.idempotencyKey,
  profileFingerprint: "b".repeat(64),
  capabilityCatalogFingerprint: "c".repeat(64),
  executionBoundaryRevision: "boundary-r1",
  capabilityId: TAVILY_SEARCH_CAPABILITY_ID,
  operation: TAVILY_SEARCH_OPERATION,
  resource: TAVILY_SEARCH_RESOURCE,
  audience: { tenantId: "tenant-1", environmentId: "environment-1" },
  brokerAuthority: { authorityId: "broker-1", revision: "broker-r1" },
  credentialReference: { credentialId: "tool.tavily.default", revision: "credential-r1" },
  policyRevision: "policy-r1",
};
const leaseRecord = {
  version: 1,
  leaseId: "lease-1",
  sequence: 1,
  transition: "requested",
  binding: leaseBinding,
  bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(leaseBinding),
  usage: { requestLimit: 1, requestsConsumed: 0, responseByteLimit: 4096, responseBytesConsumed: 0, exactProviderUsage: null },
  expiresAt: "2026-08-23T12:05:00.000Z",
  occurredAt: timestamp,
} as never;

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
  const cancellationWins = new InMemorySessionStore({ tenantId: "tenant-1" });
  await cancellationWins.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: leaseRecord });
  (cancellationWins as unknown as { effects: PersistedEffect[] }).effects.push({ ...effect, status: "PENDING" });
  assert.deepEqual(await cancellationWins.claimExactEffectCancellation({ ...requested, tenantId: "tenant-2" }), { status: "not_found" });
  assert.equal((await cancellationWins.getPersistedEffect(requested.idempotencyKey))?.status, "PENDING");
  assert.deepEqual(await cancellationWins.claimExactEffectCancellation({ ...requested, tenantId: "tenant-1" }), { status: "cancelled" });
  await assert.rejects(
    cancellationWins.saveEffectResult(requested.runId, requested.sessionId, effectResult),
    SandboxCapabilityExactResultCancelledError,
  );
  await cancellationWins.saveEffectResult(requested.runId, requested.sessionId, {
    idempotencyKey: requested.idempotencyKey,
    status: "FAILED",
    error: { code: "EFFECT_EXECUTION_FAILED", message: "cancelled" },
    timestamp,
  });
  await assert.rejects(
    cancellationWins.markEffectStatus(requested.idempotencyKey, "DONE", requested),
    SandboxCapabilityExactResultCancelledError,
  );
  await assert.rejects(cancellationWins.saveSandboxCapabilityEffectResult({
    leaseId: "lease-1",
    bindingDigest: "a".repeat(64),
    toolCallId: requested.idempotencyKey,
    runId: requested.runId,
    sessionId: requested.sessionId,
    result: effectResult,
  }), SandboxCapabilityExactResultCancelledError);

  const completionWins = new InMemorySessionStore({ tenantId: "tenant-1" });
  await completionWins.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: leaseRecord });
  (completionWins as unknown as { effects: PersistedEffect[] }).effects.push({ ...effect, status: "PENDING" });
  await completionWins.saveEffectResult(requested.runId, requested.sessionId, effectResult);
  assert.deepEqual(await completionWins.claimExactEffectCancellation({ ...requested, tenantId: "tenant-2" }), { status: "not_found" });
  assert.deepEqual(await completionWins.getEffectResult(requested.idempotencyKey), effectResult);
  assert.deepEqual(await completionWins.claimExactEffectCancellation({ ...requested, tenantId: "tenant-1" }), { status: "completed" });
  assert.equal((await completionWins.getPersistedEffect(requested.idempotencyKey))?.status, "PENDING");
});

test("in-memory ordinary code execution uses store-owned tenant authority for both winner orders", async () => {
  type OwnedEffect = PersistedEffect & { tenantId: string };
  const { capability: _ignoredCapability, ...ordinaryInput } = preparedToolCall.effectiveInput;
  const ordinaryEffect: OwnedEffect = {
    ...effect,
    status: "PENDING",
    tenantId: "tenant-1",
    payload: { preparedToolCall: { ...preparedToolCall, effectiveInput: ordinaryInput } },
  };
  const ordinaryEffectResult = {
    ...effectResult,
    output: { ...result, auditRecord: { ...result.auditRecord, input: ordinaryInput } },
  };
  const cancellationWins = new InMemorySessionStore({ tenantId: "tenant-1" });
  (cancellationWins as unknown as { effects: OwnedEffect[] }).effects.push(ordinaryEffect);
  await assert.rejects(
    cancellationWins.saveEffectResult("run-wrong", requested.sessionId, ordinaryEffectResult),
    /owner does not match/u,
  );
  await assert.rejects(
    cancellationWins.saveEffectResult(requested.runId, "session-wrong", ordinaryEffectResult),
    /owner does not match/u,
  );
  await assert.rejects(
    cancellationWins.markEffectStatus(requested.idempotencyKey, "DONE", { runId: "run-wrong", sessionId: requested.sessionId }),
    /owner or tenant does not match/u,
  );
  await assert.rejects(
    cancellationWins.markEffectStatus(requested.idempotencyKey, "FAILED", { runId: "run-wrong", sessionId: requested.sessionId }),
    /owner or tenant does not match/u,
  );
  assert.equal(await cancellationWins.getEffectResult(requested.idempotencyKey), null);
  assert.equal((await cancellationWins.getPersistedEffect(requested.idempotencyKey))?.status, "PENDING");
  assert.deepEqual(await cancellationWins.claimExactEffectCancellation({ ...requested, tenantId: "tenant-2" }), { status: "not_found" });
  assert.deepEqual(await cancellationWins.claimExactEffectCancellation({ ...requested, tenantId: "tenant-1" }), { status: "cancelled" });
  await assert.rejects(cancellationWins.saveEffectResult(requested.runId, requested.sessionId, ordinaryEffectResult), SandboxCapabilityExactResultCancelledError);

  const completionWins = new InMemorySessionStore({ tenantId: "tenant-1" });
  (completionWins as unknown as { effects: OwnedEffect[] }).effects.push({ ...structuredClone(ordinaryEffect), status: "PENDING" });
  await completionWins.saveEffectResult(requested.runId, requested.sessionId, ordinaryEffectResult);
  assert.deepEqual(await completionWins.claimExactEffectCancellation({ ...requested, tenantId: "tenant-2" }), { status: "not_found" });
  assert.deepEqual(await completionWins.claimExactEffectCancellation({ ...requested, tenantId: "tenant-1" }), { status: "completed" });

  const wrongTenant = new InMemorySessionStore({ tenantId: "tenant-2" });
  (wrongTenant as unknown as { effects: OwnedEffect[] }).effects.push({ ...structuredClone(ordinaryEffect), status: "PENDING" });
  await assert.rejects(
    wrongTenant.saveEffectResult(requested.runId, requested.sessionId, ordinaryEffectResult),
    /tenant does not match/u,
  );
  await assert.rejects(
    wrongTenant.markEffectStatus(requested.idempotencyKey, "DONE", requested),
    /tenant does not match/u,
  );
  await assert.rejects(
    wrongTenant.markEffectStatus(requested.idempotencyKey, "FAILED", requested),
    /tenant does not match/u,
  );
  assert.equal(await wrongTenant.getEffectResult(requested.idempotencyKey), null);
  assert.equal((await wrongTenant.getPersistedEffect(requested.idempotencyKey))?.status, "PENDING");
});

test("in-memory run ownership ignores spoofed event tenant input", async () => {
  const store = new InMemorySessionStore({ tenantId: "tenant-trusted" });
  await store.ensureSession("session-owned");
  await store.startRun("run-owned", {
    id: "event-owned",
    type: "user.message",
    sessionId: "session-owned",
    payload: { actor: { tenantId: "tenant-spoofed" } },
  });
  const run = (store as unknown as { runs: Map<string, { tenantId?: string }> }).runs.get("run-owned");
  assert.equal(run?.tenantId, "tenant-trusted");
});

test("exact effect result reads bind the persisted capability lease to trusted tenant authority", () => {
  const found = validateExactEffectResultRead({ requested, effect, effectResult });
  const lease = { leaseId: "lease-1", binding: { tenantId: "tenant-1", sessionId: requested.sessionId, runId: requested.runId, toolCallId: requested.idempotencyKey } } as never;
  assert.deepEqual(validateExactEffectResultTenantBinding({ read: found, requested: { ...requested, tenantId: "tenant-1" }, lease }), found);
  assert.deepEqual(validateExactEffectResultTenantBinding({ read: found, requested: { ...requested, tenantId: "tenant-2" }, lease }), { status: "not_found" });
  assert.deepEqual(validateExactEffectResultTenantBinding({ read: found, requested: { ...requested, tenantId: "tenant-1" }, lease: null }), { status: "conflict" });
});
