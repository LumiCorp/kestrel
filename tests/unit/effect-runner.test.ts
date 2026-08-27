import test from "node:test";
import assert from "node:assert/strict";

import { InlineEffectRunner } from "../../src/effects/EffectRunner.js";
import { EffectRegistry } from "../../src/effects/EffectRegistry.js";
import { createExecuteToolCallHandler } from "../../src/effects/handlers/executeToolCall.js";
import { createReleasePreparedToolCallHandler } from "../../src/effects/handlers/releasePreparedToolCall.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { InMemorySessionStore as DurableInMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import { UnifiedToolRegistry } from "../../tools/runtime/UnifiedToolRegistry.js";
import { buildAgentToolSuccessResult } from "../../tools/toolResult.js";
import { defaultToolCatalog } from "../../tools/catalog.js";
import {
  createToolActivationRefV1,
  fingerprintToolScopeV1,
} from "../../src/kestrel/contracts/tool-contract.js";
import {
  adaptLegacyTestToolGateway,
  prepareTestToolCall,
} from "../helpers/createTestToolGateway.js";
import {
  fingerprintSandboxCapabilityLeaseBindingV1,
  TAVILY_SEARCH_CAPABILITY_ID,
  TAVILY_SEARCH_OPERATION,
  TAVILY_SEARCH_RESOURCE,
  type SandboxCapabilityLeaseBindingV1,
  type SandboxCapabilityLeaseTransitionRecordV1,
} from "../../src/kestrel/contracts/sandbox-capability.js";
import type { PersistedEffect } from "../../src/kestrel/contracts/store.js";
import {
  buildPreparedApprovalCleanupDoneEvidenceQuarantineEvent,
  PREPARED_APPROVAL_CLEANUP_QUARANTINE_AUDIT_MAX_METADATA_BYTES,
} from "../../src/runtime/preparedApprovalCleanupAudit.js";

async function buildPreparedApprovalCleanupEffect(input: {
  suffix: string;
  status: PersistedEffect["status"];
}): Promise<{ effect: PersistedEffect; preparedCallId: string }> {
  const runId = `run-cleanup-${input.suffix}`;
  const sessionId = `session-cleanup-${input.suffix}`;
  const preparedToolCall = await prepareTestToolCall({
    gateway: adaptLegacyTestToolGateway({
      call: async () => ({ unreachable: true }),
    }),
    toolName: "exec_command",
    toolInput: { cmd: "true" },
    runId,
    sessionId,
    callId: `prepared-cleanup-${input.suffix}`,
  });
  return {
    preparedCallId: preparedToolCall.callId,
    effect: {
      runId,
      sessionId,
      stepIndex: 1,
      type: "release_prepared_tool_call",
      payload: {
        preparedToolCall,
        preparedApprovalCleanup: {
          version: "runner_prepared_approval_cleanup_v1",
          organizationId: `org-cleanup-${input.suffix}`,
          threadId: sessionId,
          turnId: `turn-cleanup-${input.suffix}`,
          interactionId: `interaction-cleanup-${input.suffix}`,
          requestId: `approval-cleanup-${input.suffix}`,
          failureCode: "EXTERNAL_APPROVAL_EXPIRED",
          failureMessage: "Expired.",
        },
      },
      idempotencyKey: `${preparedToolCall.callId}:release`,
      failurePolicy: "STOP",
      status: input.status,
      createdAt: "2026-08-27T00:00:00.000Z",
    },
  };
}


test("Effect runner reports compiled tool activity", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  registry.register("execute_tool_call", async () => buildAgentToolSuccessResult({
    toolName: "fs.write_text",
    input: { path: "result.txt", text: "done" },
    output: { changedFiles: ["result.txt"] },
  }));
  const activities: Array<Record<string, unknown>> = [];
  const runner = new InlineEffectRunner(store, registry);

  const outcome = await runner.runEffects(
    [{
      runId: "run-tool-activity",
      sessionId: "session-tool-activity",
      stepIndex: 2,
      type: "execute_tool_call",
      payload: {
        toolName: "fs.write_text",
        toolInput: { path: "result.txt", text: "done" },
      },
      idempotencyKey: "tool-activity-1",
      failurePolicy: "STOP",
      status: "PENDING",
      createdAt: new Date().toISOString(),
    }],
    {
      runId: "run-tool-activity",
      sessionId: "session-tool-activity",
      stepIndex: 2,
      onToolActivity: async (activity) => {
        activities.push(activity);
      },
    },
  );

  assert.equal(outcome.stop, false);
  assert.deepEqual(activities.map((activity) => ({
    phase: activity.phase,
    toolCallId: activity.toolCallId,
    toolName: activity.toolName,
  })), [
    { phase: "started", toolCallId: "tool-activity-1", toolName: "fs.write_text" },
    { phase: "completed", toolCallId: "tool-activity-1", toolName: "fs.write_text" },
  ]);
  assert.equal((activities[1]?.output as { status?: string }).status, "OK");
});

test("Effect runner durably claims immediately before invoking the validated handler", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  const effect = {
    runId: "run-claim",
    sessionId: "session-claim",
    stepIndex: 0,
    type: "test.claimed",
    payload: {},
    idempotencyKey: "claim-1",
    failurePolicy: "STOP" as const,
    status: "PENDING" as const,
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  (store as unknown as { effects: Array<Record<string, unknown>> }).effects.push({ ...effect });
  registry.register(effect.type, async () => {
    assert.equal((await store.listPendingEffects(effect.sessionId))[0]?.status, "CLAIMED");
    return { ok: true };
  });

  const outcome = await new InlineEffectRunner(store, registry).runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  });

  assert.equal(outcome.stop, false);
  assert.deepEqual(store.operationLog.filter((entry) =>
    entry.startsWith("claimEffectExecution:") || entry.startsWith("saveEffectResult:")
  ), ["claimEffectExecution:claim-1", "saveEffectResult:claim-1:DONE"]);
});

test("Effect runner repairs a split DONE result without downgrading or replaying the effect", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  const effect = {
    runId: "run-split-done",
    sessionId: "session-split-done",
    stepIndex: 0,
    type: "test.split-done",
    payload: {},
    idempotencyKey: "split-done-1",
    failurePolicy: "STOP" as const,
    status: "PENDING" as const,
    createdAt: "2026-08-27T00:00:00.000Z",
  };
  (store as unknown as { effects: Array<Record<string, unknown>> }).effects.push(
    { ...effect },
  );
  let handlerCalls = 0;
  registry.register(effect.type, async () => {
    handlerCalls += 1;
    return { released: true };
  });
  const markEffectStatus = store.markEffectStatus.bind(store);
  let injectedFailure = true;
  store.markEffectStatus = async (idempotencyKey, status, owner) => {
    if (status === "DONE" && injectedFailure) {
      injectedFailure = false;
      throw new Error("Injected crash after saving the DONE result.");
    }
    await markEffectStatus(idempotencyKey, status, owner);
  };

  const outcome = await new InlineEffectRunner(store, registry).runEffects(
    [effect],
    {
      runId: effect.runId,
      sessionId: effect.sessionId,
      stepIndex: effect.stepIndex,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(handlerCalls, 1);
  assert.equal((await store.getEffectResult(effect.idempotencyKey))?.status, "DONE");
  assert.equal((await store.getPersistedEffect(effect.idempotencyKey))?.status, "DONE");
  assert.equal(
    store.operationLog.includes(
      `markEffectStatus:${effect.idempotencyKey}:FAILED`,
    ),
    false,
  );
});

test("Effect runner records terminal unknown and never repeats a claimed prepared call without a result", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  let handlerCalls = 0;
  registry.register("execute_tool_call", async () => {
    handlerCalls += 1;
    return { repeated: true };
  });
  const gateway = adaptLegacyTestToolGateway({
    validateInput: async (_name, input) => input,
    call: async () => ({ unreachable: true }),
  });
  const preparedToolCall = await prepareTestToolCall({
    gateway,
    toolName: "fs.write_text",
    toolInput: { path: "unknown.txt", text: "once" },
    runId: "run-original",
    sessionId: "session-unknown",
    callId: "call-unknown",
  });
  const effect = {
    runId: "run-continuation",
    sessionId: "session-unknown",
    stepIndex: 1,
    type: "execute_tool_call",
    payload: { preparedToolCall },
    idempotencyKey: "call-unknown",
    failurePolicy: "STOP" as const,
    status: "CLAIMED" as const,
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  (store as unknown as { effects: Array<Record<string, unknown>> }).effects.push({ ...effect });
  const runner = new InlineEffectRunner(store, registry);

  const first = await runner.runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  });
  const recorded = await store.getEffectResult(effect.idempotencyKey);
  const output = recorded?.output as { toolCallId?: string; outcome?: { effectState?: string; retryable?: boolean } };
  assert.equal(first.stop, true);
  assert.equal(first.errors[0]?.code, "EFFECT_EXECUTION_OUTCOME_UNKNOWN");
  assert.equal(recorded?.status, "FAILED");
  assert.equal(output.toolCallId, effect.idempotencyKey);
  assert.deepEqual(output.outcome, {
    ...(output.outcome ?? {}),
    effectState: "unknown",
    retryable: false,
  });
  assert.equal(handlerCalls, 0);

  const replay = await runner.runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  });
  assert.equal(replay.stop, true);
  assert.equal(handlerCalls, 0);
});

test("Effect runner accepts a continuation effect run while preserving prepared identity", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  let handlerCalls = 0;
  registry.register("execute_tool_call", async () => {
    handlerCalls += 1;
    return { ok: true };
  });
  const gateway = adaptLegacyTestToolGateway({
    validateInput: async (_name, input) => input,
    call: async () => ({ unreachable: true }),
  });
  const preparedToolCall = await prepareTestToolCall({
    gateway,
    toolName: "fs.write_text",
    toolInput: { path: "continuation.txt", text: "exact" },
    runId: "run-original",
    sessionId: "session-continuation",
    callId: "call-continuation",
  });
  const effect = {
    runId: "run-continuation",
    sessionId: preparedToolCall.sessionId,
    stepIndex: 2,
    type: "execute_tool_call",
    payload: { preparedToolCall },
    idempotencyKey: preparedToolCall.callId,
    failurePolicy: "STOP" as const,
    status: "PENDING" as const,
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  (store as unknown as { effects: Array<Record<string, unknown>> }).effects.push({ ...effect });

  const outcome = await new InlineEffectRunner(store, registry).runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  });

  assert.equal(outcome.stop, false);
  assert.equal(handlerCalls, 1);
  assert.equal(preparedToolCall.runId, "run-original");
});

test("Effect runner STOP policy halts on failure", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  registry.register("explode", async () => {
    throw new Error("boom");
  });

  const runner = new InlineEffectRunner(store, registry);

  const outcome = await runner.runEffects(
    [
      {
        runId: "run-1",
        sessionId: "s1",
        stepIndex: 0,
        type: "explode",
        payload: {},
        idempotencyKey: "k1",
        failurePolicy: "STOP",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      runId: "run-1",
      sessionId: "s1",
      stepIndex: 0,
    },
  );

  assert.equal(outcome.stop, true);
  assert.equal(outcome.terminalStatus, "FAILED");
  assert.equal(outcome.errors.length, 1);
});

test("two cleanup runners converge when FAILED commits before atomic release success", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  const preparedToolCall = await prepareTestToolCall({
    gateway: adaptLegacyTestToolGateway({
      call: async () => ({ unreachable: true }),
    }),
    toolName: "exec_command",
    toolInput: { cmd: "true" },
    runId: "run-cleanup-retry",
    sessionId: "thread-cleanup-retry",
    callId: "prepared-cleanup",
  });
  let calls = 0;
  registry.register("release_prepared_tool_call", async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient release failure");
    return { releasedPreparedInvocationId: preparedToolCall.callId };
  });
  const effect = {
    runId: "run-cleanup-retry",
    sessionId: "thread-cleanup-retry",
    stepIndex: 1,
    type: "release_prepared_tool_call",
    payload: {
      preparedToolCall,
      preparedApprovalCleanup: {
        version: "runner_prepared_approval_cleanup_v1" as const,
        organizationId: "org-cleanup",
        threadId: "thread-cleanup-retry",
        turnId: "turn-cleanup",
        interactionId: "interaction-cleanup",
        requestId: "approval-cleanup",
        failureCode: "EXTERNAL_APPROVAL_EXPIRED" as const,
        failureMessage: "Expired.",
      },
    },
    idempotencyKey: `${preparedToolCall.callId}:release`,
    failurePolicy: "STOP" as const,
    status: "PENDING" as const,
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  (store as unknown as { effects: Array<Record<string, unknown>> }).effects.push({ ...effect });
  const failingRunner = new InlineEffectRunner(store, registry);
  const successfulRunner = new InlineEffectRunner(store, registry);

  const failed = await failingRunner.runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  });
  assert.equal(failed.stop, true);
  assert.equal((await store.getEffectResult(effect.idempotencyKey))?.status, "FAILED");

  const retried = await successfulRunner.runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  });
  assert.equal(retried.stop, false);
  assert.equal(calls, 2);
  assert.equal((await store.getEffectResult(effect.idempotencyKey))?.status, "DONE");
  assert.equal(
    (await store.getPersistedEffect(effect.idempotencyKey))?.status,
    "DONE",
  );
  await store.saveEffectResult(effect.runId, effect.sessionId, {
    idempotencyKey: effect.idempotencyKey,
    status: "FAILED",
    error: {
      code: "EFFECT_EXECUTION_FAILED",
      message: "stale failing runner",
    },
    timestamp: "2026-08-27T00:00:02.000Z",
  });
  await store.markEffectStatus(effect.idempotencyKey, "FAILED", effect);
  assert.equal((await store.getEffectResult(effect.idempotencyKey))?.status, "DONE");
  assert.equal(
    (await store.getPersistedEffect(effect.idempotencyKey))?.status,
    "DONE",
  );
  const exactDone = await store.getEffectResult(effect.idempotencyKey);
  assert.equal(exactDone?.status, "DONE");
  if (exactDone?.status !== "DONE") {
    throw new Error("Expected exact cleanup DONE evidence.");
  }
  await store.commitPreparedApprovalCleanupEffectDone(
    effect.idempotencyKey,
    effect,
    {
      ...exactDone,
      status: "DONE",
      timestamp: "2026-08-27T00:00:03.000Z",
    },
  );
  await assert.rejects(
    store.commitPreparedApprovalCleanupEffectDone(
      effect.idempotencyKey,
      effect,
      {
        ...exactDone,
        status: "DONE",
        output: { releasedPreparedInvocationId: "wrong-prepared-call" },
        timestamp: "2026-08-27T00:00:04.000Z",
      },
    ),
    /exact prepared invocation|exact durable authority/u,
  );
  assert.deepEqual(
    await store.getEffectResult(effect.idempotencyKey),
    exactDone,
  );
  assert.equal(
    store.operationLog.filter((entry) =>
      entry === `resetPreparedApprovalCleanupEffectExecution:${effect.idempotencyKey}`
    ).length,
    1,
  );
  assert.equal(
    store.operationLog.filter((entry) =>
      entry ===
        `commitPreparedApprovalCleanupEffectDone:${effect.idempotencyKey}`
    ).length,
    2,
  );
});

test("cleanup DONE quarantine preserves malformed audit evidence across effect states", async () => {
  for (const status of ["PENDING", "CLAIMED", "FAILED"] as const) {
    const store = new InMemorySessionStore();
    const { effect } = await buildPreparedApprovalCleanupEffect({
      suffix: `audit-${status.toLowerCase()}`,
      status,
    });
    (store as unknown as { effects: PersistedEffect[] }).effects.push(
      structuredClone(effect),
    );
    const malformedOutput = {
      releasedPreparedInvocationId: "wrong-prepared-call",
      unexpected: true,
    };
    const timestamp = "2026-08-27T00:00:01.000Z";
    await store.saveEffectResult(effect.runId, effect.sessionId, {
      idempotencyKey: effect.idempotencyKey,
      status: "DONE",
      output: malformedOutput,
      timestamp,
    });

    assert.equal(
      await store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
        effect.idempotencyKey,
        effect,
      ),
      "quarantined",
    );
    assert.equal(
      (await store.getPersistedEffect(effect.idempotencyKey))?.status,
      "PENDING",
    );
    const quarantined = await store.getEffectResult(effect.idempotencyKey);
    assert.equal(quarantined?.status, "FAILED");
    assert.equal(quarantined?.timestamp, timestamp);
    assert.deepEqual(quarantined?.output, malformedOutput);
    assert.equal(
      quarantined?.error?.code,
      "PREPARED_APPROVAL_CLEANUP_DONE_EVIDENCE_INVALID",
    );
  }
});

test("cleanup DONE quarantine audit is deterministic, bounded, and secret-free", async () => {
  const { effect } = await buildPreparedApprovalCleanupEffect({
    suffix: "bounded-audit",
    status: "FAILED",
  });
  const cyclicOutput: Record<string, unknown> = {
    releasedPreparedInvocationId: "private-prepared-call-sentinel",
    authorization: "Bearer authorization-sentinel",
    apiKey: "api-key-sentinel",
    url: "https://private.example.invalid/provider?token=url-token-sentinel",
    providerPayload: {
      token: "provider-token-sentinel",
      nested: { password: "password-sentinel" },
    },
    oversized: "oversized-secret-sentinel".repeat(100_000),
    invalidUnicode: "invalid\ud800unicode",
  };
  cyclicOutput.self = cyclicOutput;
  for (let index = 0; index < 32; index += 1) {
    cyclicOutput[`extra-${index}`] = `extra-secret-${index}`;
  }
  const invalidResult = {
    idempotencyKey: effect.idempotencyKey,
    status: "DONE" as const,
    output: cyclicOutput,
    error: {
      code: "PROVIDER_ERROR",
      message: "provider-error-message-sentinel",
      details: { authToken: "error-token-sentinel" },
    },
    timestamp: "2026-08-27T00:00:01.000Z",
  };
  const first = buildPreparedApprovalCleanupDoneEvidenceQuarantineEvent({
    effect,
    invalidResult,
    occurredAt: "2026-08-27T00:00:02.000Z",
  });
  const second = buildPreparedApprovalCleanupDoneEvidenceQuarantineEvent({
    effect,
    invalidResult,
    occurredAt: "2026-08-27T00:00:02.000Z",
  });

  assert.deepEqual(first, second);
  const serialized = JSON.stringify(first);
  for (const sentinel of [
    "private-prepared-call-sentinel",
    "authorization-sentinel",
    "api-key-sentinel",
    "private.example.invalid",
    "url-token-sentinel",
    "provider-token-sentinel",
    "password-sentinel",
    "oversized-secret-sentinel",
    "provider-error-message-sentinel",
    "error-token-sentinel",
  ]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(first.metadata)) <=
      PREPARED_APPROVAL_CLEANUP_QUARANTINE_AUDIT_MAX_METADATA_BYTES,
  );
  assert.equal(
    first.metadata?.validationReasonCode,
    "PREPARED_APPROVAL_CLEANUP_DONE_EVIDENCE_INVALID",
  );
  const evidence = first.metadata?.evidence as Record<string, unknown>;
  assert.match(String(evidence.canonicalHash), /^sha256:[0-9a-f]{64}$/u);
  assert.equal(evidence.sourceBytesTruncated, true);
  assert.equal(evidence.traversalTruncated, true);
  assert.ok(Number(evidence.nodesVisited) <= 128);
  assert.deepEqual(evidence.outputShape, {
    type: "object",
    topLevelEntriesObserved: 16,
    topLevelEntriesTruncated: true,
    topLevelValueTypes: { string: 14, object: 1, truncated: 1 },
  });
  assert.deepEqual(evidence.errorShape, {
    type: "object",
    topLevelEntriesObserved: 3,
    topLevelEntriesTruncated: false,
    topLevelValueTypes: { string: 2, object: 1 },
  });
  assert.match(
    String((first.metadata?.releasedPreparedInvocationId as Record<string, unknown>)
      .canonicalHash),
    /^sha256:[0-9a-f]{64}$/u,
  );
});

test("cleanup DONE quarantine preserves exact evidence and refuses ordinary effects", async () => {
  const store = new InMemorySessionStore();
  const { effect, preparedCallId } = await buildPreparedApprovalCleanupEffect({
    suffix: "exact-immutable",
    status: "FAILED",
  });
  (store as unknown as { effects: PersistedEffect[] }).effects.push(
    structuredClone(effect),
  );
  const exactResult = {
    idempotencyKey: effect.idempotencyKey,
    status: "DONE" as const,
    output: { releasedPreparedInvocationId: preparedCallId },
    timestamp: "2026-08-27T00:00:02.000Z",
  };
  await store.saveEffectResult(effect.runId, effect.sessionId, exactResult);
  assert.equal(
    await store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
      effect.idempotencyKey,
      effect,
    ),
    "done",
  );
  assert.deepEqual(await store.getEffectResult(effect.idempotencyKey), exactResult);
  assert.equal(
    (await store.getPersistedEffect(effect.idempotencyKey))?.status,
    "DONE",
  );

  const ordinary = {
    ...effect,
    idempotencyKey: `${effect.idempotencyKey}:ordinary`,
    payload: { preparedToolCall: effect.payload.preparedToolCall },
    status: "PENDING" as const,
  };
  (store as unknown as { effects: PersistedEffect[] }).effects.push(
    structuredClone(ordinary),
  );
  const ordinaryResult = {
    idempotencyKey: ordinary.idempotencyKey,
    status: "DONE" as const,
    output: { releasedPreparedInvocationId: preparedCallId },
    timestamp: "2026-08-27T00:00:03.000Z",
  };
  await store.saveEffectResult(ordinary.runId, ordinary.sessionId, ordinaryResult);
  assert.equal(
    await store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
      ordinary.idempotencyKey,
      ordinary,
    ),
    "conflict",
  );
  assert.deepEqual(
    await store.getEffectResult(ordinary.idempotencyKey),
    ordinaryResult,
  );
  assert.equal(
    (await store.getPersistedEffect(ordinary.idempotencyKey))?.status,
    "PENDING",
  );
});

test("effect runner quarantines an existing malformed cleanup DONE and releases once", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  const { effect, preparedCallId } = await buildPreparedApprovalCleanupEffect({
    suffix: "existing-done",
    status: "PENDING",
  });
  (store as unknown as { effects: PersistedEffect[] }).effects.push(
    structuredClone(effect),
  );
  await store.saveEffectResult(effect.runId, effect.sessionId, {
    idempotencyKey: effect.idempotencyKey,
    status: "DONE",
    output: { releasedPreparedInvocationId: "wrong-call" },
    timestamp: "2026-08-27T00:00:01.000Z",
  });
  let releases = 0;
  registry.register("release_prepared_tool_call", async () => {
    releases += 1;
    return { releasedPreparedInvocationId: preparedCallId };
  });

  const outcome = await new InlineEffectRunner(store, registry).runEffects(
    [effect],
    {
      runId: effect.runId,
      sessionId: effect.sessionId,
      stepIndex: effect.stepIndex,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(releases, 1);
  assert.equal((await store.getPersistedEffect(effect.idempotencyKey))?.status, "DONE");
  assert.deepEqual((await store.getEffectResult(effect.idempotencyKey))?.output, {
    releasedPreparedInvocationId: preparedCallId,
  });
});

test("effect runner quarantines malformed cleanup DONE from a claim race", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  const { effect, preparedCallId } = await buildPreparedApprovalCleanupEffect({
    suffix: "claim-race",
    status: "PENDING",
  });
  (store as unknown as { effects: PersistedEffect[] }).effects.push(
    structuredClone(effect),
  );
  const claimEffectExecution = store.claimEffectExecution.bind(store);
  let injectRace = true;
  store.claimEffectExecution = async (idempotencyKey, owner) => {
    if (injectRace) {
      injectRace = false;
      await store.saveEffectResult(effect.runId, effect.sessionId, {
        idempotencyKey,
        status: "DONE",
        output: { releasedPreparedInvocationId: "claim-race-wrong-call" },
        timestamp: "2026-08-27T00:00:01.000Z",
      });
      return "terminal";
    }
    return claimEffectExecution(idempotencyKey, owner);
  };
  let releases = 0;
  registry.register("release_prepared_tool_call", async () => {
    releases += 1;
    return { releasedPreparedInvocationId: preparedCallId };
  });

  const outcome = await new InlineEffectRunner(store, registry).runEffects(
    [effect],
    {
      runId: effect.runId,
      sessionId: effect.sessionId,
      stepIndex: effect.stepIndex,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(releases, 1);
  assert.equal((await store.getPersistedEffect(effect.idempotencyKey))?.status, "DONE");
  assert.deepEqual((await store.getEffectResult(effect.idempotencyKey))?.output, {
    releasedPreparedInvocationId: preparedCallId,
  });
});

test("effect runner validates and quarantines malformed cleanup DONE from a reset race", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  const { effect, preparedCallId } = await buildPreparedApprovalCleanupEffect({
    suffix: "reset-race",
    status: "FAILED",
  });
  (store as unknown as { effects: PersistedEffect[] }).effects.push(
    structuredClone(effect),
  );
  await store.saveEffectResult(effect.runId, effect.sessionId, {
    idempotencyKey: effect.idempotencyKey,
    status: "FAILED",
    error: { code: "EFFECT_EXECUTION_FAILED", message: "retryable failure" },
    timestamp: "2026-08-27T00:00:01.000Z",
  });
  const resetPreparedApprovalCleanupEffectExecution =
    store.resetPreparedApprovalCleanupEffectExecution.bind(store);
  let injectRace = true;
  store.resetPreparedApprovalCleanupEffectExecution = async (
    idempotencyKey,
    owner,
  ) => {
    const reset = await resetPreparedApprovalCleanupEffectExecution(
      idempotencyKey,
      owner,
    );
    if (injectRace) {
      injectRace = false;
      assert.equal(reset, "reset");
      await store.saveEffectResult(effect.runId, effect.sessionId, {
        idempotencyKey,
        status: "DONE",
        output: { releasedPreparedInvocationId: "reset-race-wrong-call" },
        timestamp: "2026-08-27T00:00:02.000Z",
      });
      return "done";
    }
    return reset;
  };
  let releases = 0;
  registry.register("release_prepared_tool_call", async () => {
    releases += 1;
    return { releasedPreparedInvocationId: preparedCallId };
  });

  const outcome = await new InlineEffectRunner(store, registry).runEffects(
    [effect],
    {
      runId: effect.runId,
      sessionId: effect.sessionId,
      stepIndex: effect.stepIndex,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(releases, 1);
  assert.equal((await store.getPersistedEffect(effect.idempotencyKey))?.status, "DONE");
  assert.deepEqual((await store.getEffectResult(effect.idempotencyKey))?.output, {
    releasedPreparedInvocationId: preparedCallId,
  });
});

test("two cleanup runners serialize release and retain quarantine audit after convergence", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  const { effect, preparedCallId } = await buildPreparedApprovalCleanupEffect({
    suffix: "serialized-convergence",
    status: "PENDING",
  });
  (store as unknown as { effects: PersistedEffect[] }).effects.push(
    structuredClone(effect),
  );
  const originalTimestamp = "2026-08-27T00:00:01.000Z";
  await store.saveEffectResult(effect.runId, effect.sessionId, {
    idempotencyKey: effect.idempotencyKey,
    status: "DONE",
    output: {
      releasedPreparedInvocationId: "wrong-call",
      malformedText: "invalid\u0000audit",
    },
    timestamp: originalTimestamp,
  });
  assert.equal(
    await store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
      effect.idempotencyKey,
      effect,
    ),
    "quarantined",
  );
  assert.equal(
    await store.resetPreparedApprovalCleanupEffectExecution(
      effect.idempotencyKey,
      effect,
    ),
    "reset",
  );
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });
  let releases = 0;
  registry.register("release_prepared_tool_call", async () => {
    releases += 1;
    handlerStarted();
    await handlerGate;
    return { releasedPreparedInvocationId: preparedCallId };
  });
  const context = {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  };
  const first = new InlineEffectRunner(store, registry).runEffects(
    [effect],
    context,
  );
  await started;
  const second = new InlineEffectRunner(store, registry).runEffects(
    [effect],
    context,
  );
  await Promise.resolve();
  releaseHandler();
  const outcomes = await Promise.all([first, second]);

  assert.deepEqual(outcomes.map((outcome) => outcome.stop), [false, false]);
  assert.equal(releases, 1);
  assert.equal((await store.getPersistedEffect(effect.idempotencyKey))?.status, "DONE");
  assert.deepEqual((await store.getEffectResult(effect.idempotencyKey))?.output, {
    releasedPreparedInvocationId: preparedCallId,
  });
  const quarantineEvents = store.getRunEvents().filter((event) =>
    event.type === "prepared_approval_cleanup.done_evidence_quarantined"
  );
  assert.equal(quarantineEvents.length, 1);
  assert.deepEqual(quarantineEvents[0]?.metadata?.resultIdentity, {
    idempotencyKey: effect.idempotencyKey,
    status: "DONE",
    originalTimestamp,
  });
  const serializedAudit = JSON.stringify(quarantineEvents[0]);
  assert.equal(serializedAudit.includes("wrong-call"), false);
  assert.equal(serializedAudit.includes("invalid\uFFFDaudit"), false);
  assert.match(
    String((quarantineEvents[0]?.metadata?.evidence as Record<string, unknown>)
      .canonicalHash),
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(quarantineEvents[0]?.metadata)) <=
      PREPARED_APPROVAL_CLEANUP_QUARANTINE_AUDIT_MAX_METADATA_BYTES,
  );

  const replay = await new InlineEffectRunner(store, registry).runEffects(
    [effect],
    context,
  );
  assert.equal(replay.stop, false);
  assert.equal(releases, 1, "exact DONE recheck must skip the handler");
  assert.equal(
    store.getRunEvents().filter((event) =>
      event.type === "prepared_approval_cleanup.done_evidence_quarantined"
    ).length,
    1,
  );
});

test("cleanup critical section releases after a thrown handler and permits retry", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  const { effect, preparedCallId } = await buildPreparedApprovalCleanupEffect({
    suffix: "critical-section-throw",
    status: "PENDING",
  });
  (store as unknown as { effects: PersistedEffect[] }).effects.push(
    structuredClone(effect),
  );
  let attempts = 0;
  registry.register("release_prepared_tool_call", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("injected cleanup handler crash");
    return { releasedPreparedInvocationId: preparedCallId };
  });
  const runner = new InlineEffectRunner(store, registry);
  const context = {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  };

  const crashed = await runner.runEffects([effect], context);
  const retried = await runner.runEffects([effect], context);

  assert.equal(crashed.stop, true);
  assert.equal(retried.stop, false);
  assert.equal(attempts, 2);
  assert.equal((await store.getPersistedEffect(effect.idempotencyKey))?.status, "DONE");
  assert.deepEqual((await store.getEffectResult(effect.idempotencyKey))?.output, {
    releasedPreparedInvocationId: preparedCallId,
  });
});

test("cleanup critical section refuses ordinary effects without invoking the handler", async () => {
  const store = new InMemorySessionStore();
  const { effect } = await buildPreparedApprovalCleanupEffect({
    suffix: "ordinary-isolation",
    status: "CLAIMED",
  });
  const ordinary = {
    ...effect,
    payload: { preparedToolCall: effect.payload.preparedToolCall },
  };
  (store as unknown as { effects: PersistedEffect[] }).effects.push(
    structuredClone(ordinary),
  );
  let handlerCalls = 0;
  const outcome = await store.executePreparedApprovalCleanupInCriticalSection(
    ordinary.idempotencyKey,
    ordinary,
    async () => {
      handlerCalls += 1;
      throw new Error("ordinary handler must not run");
    },
  );

  assert.deepEqual(outcome, { status: "conflict" });
  assert.equal(handlerCalls, 0);
  assert.equal((await store.getPersistedEffect(ordinary.idempotencyKey))?.status, "CLAIMED");
});

test("ordinary failed release remains terminal and is never retried", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  let calls = 0;
  registry.register("release_prepared_tool_call", async () => {
    calls += 1;
    throw new Error("ordinary release failure");
  });
  const effect = {
    runId: "run-ordinary-release",
    sessionId: "session-ordinary-release",
    stepIndex: 1,
    type: "release_prepared_tool_call",
    payload: {},
    idempotencyKey: "ordinary:release",
    failurePolicy: "STOP" as const,
    status: "PENDING" as const,
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  (store as unknown as { effects: Array<Record<string, unknown>> }).effects.push({ ...effect });
  const runner = new InlineEffectRunner(store, registry);
  await runner.runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  });
  await runner.runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  });
  assert.equal(calls, 1);
});

test("cleanup-only release recovers a crash after claim and before release", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  const preparedToolCall = await prepareTestToolCall({
    gateway: adaptLegacyTestToolGateway({
      call: async () => ({ unreachable: true }),
    }),
    toolName: "exec_command",
    toolInput: { cmd: "true" },
    runId: "run-cleanup-claimed",
    sessionId: "thread-cleanup-claimed",
    callId: "prepared-cleanup-claimed",
  });
  let calls = 0;
  registry.register("release_prepared_tool_call", async () => {
    calls += 1;
    return { releasedPreparedInvocationId: preparedToolCall.callId };
  });
  const effect = {
    runId: "run-cleanup-claimed",
    sessionId: "thread-cleanup-claimed",
    stepIndex: 1,
    type: "release_prepared_tool_call",
    payload: {
      preparedToolCall,
      preparedApprovalCleanup: {
        version: "runner_prepared_approval_cleanup_v1" as const,
        organizationId: "org-cleanup",
        threadId: "thread-cleanup-claimed",
        turnId: "turn-cleanup",
        interactionId: "interaction-cleanup",
        requestId: "approval-cleanup",
        failureCode: "EXTERNAL_APPROVAL_POLICY_CHANGED" as const,
        failureMessage: "Policy changed.",
      },
    },
    idempotencyKey: `${preparedToolCall.callId}:release`,
    failurePolicy: "STOP" as const,
    status: "CLAIMED" as const,
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  (store as unknown as { effects: Array<Record<string, unknown>> }).effects.push({ ...effect });
  const outcome = await new InlineEffectRunner(store, registry).runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  });
  assert.equal(outcome.stop, false);
  assert.equal(calls, 1);
});

test("Effect runner CONTINUE policy keeps running", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();

  registry.register("explode", async () => {
    throw new Error("boom");
  });
  registry.register("ok", async () => ({ ok: true }));

  const runner = new InlineEffectRunner(store, registry);

  const outcome = await runner.runEffects(
    [
      {
        runId: "run-1",
        sessionId: "s1",
        stepIndex: 0,
        type: "explode",
        payload: {},
        idempotencyKey: "k1",
        failurePolicy: "CONTINUE",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
      {
        runId: "run-1",
        sessionId: "s1",
        stepIndex: 0,
        type: "ok",
        payload: {},
        idempotencyKey: "k2",
        failurePolicy: "STOP",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      runId: "run-1",
      sessionId: "s1",
      stepIndex: 0,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(outcome.errors.length, 1);

  const results = store.getEffectResults();
  assert.equal(results.length, 2);
  assert.equal(results.find((result) => result.idempotencyKey === "k2")?.status, "DONE");
});

test("restart consumes a recorded tool result without repeating the effect", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  let handlerCalls = 0;
  registry.register("execute_tool_call", async () => {
    handlerCalls += 1;
    return { repeated: true };
  });
  await store.saveEffectResult("run-recorded", "session-recorded", {
    idempotencyKey: "tool-recorded-result",
    status: "DONE",
    output: { recorded: true },
    timestamp: "2026-08-03T00:00:00.000Z",
  });

  const runner = new InlineEffectRunner(store, registry);
  const outcome = await runner.runEffects(
    [{
      runId: "run-recorded",
      sessionId: "session-recorded",
      stepIndex: 0,
      type: "execute_tool_call",
      payload: {
        toolName: "test.external.recorded",
        toolInput: { value: "once" },
      },
      idempotencyKey: "tool-recorded-result",
      failurePolicy: "STOP",
      status: "PENDING",
      createdAt: "2026-08-03T00:00:00.000Z",
    }],
    {
      runId: "run-recorded",
      sessionId: "session-recorded",
      stepIndex: 0,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(handlerCalls, 0);
  assert.equal(store.getEffectResults()[0]?.status, "DONE");
});

test("recorded sandbox capability result replay never resolves credentials, contacts the provider, or starts Docker", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  let credentialResolutions = 0;
  let providerCalls = 0;
  let dockerStarts = 0;
  registry.register("execute_tool_call", async () => {
    credentialResolutions += 1;
    providerCalls += 1;
    dockerStarts += 1;
    return { repeated: true };
  });
  await store.saveEffectResult("run-capability-replay", "session-capability-replay", {
    idempotencyKey: "capability-action-digest-1",
    status: "DONE",
    output: { status: "ok", stdout: "recorded Tavily result" },
    timestamp: "2026-08-23T00:00:00.000Z",
  });

  const outcome = await new InlineEffectRunner(store, registry).runEffects([{
    runId: "run-capability-replay",
    sessionId: "session-capability-replay",
    stepIndex: 0,
    type: "execute_tool_call",
    payload: {
      toolName: "code.execute",
      toolInput: { capability: { capabilityId: "tavily.search.read", input: { query: "recorded" } } },
    },
    idempotencyKey: "capability-action-digest-1",
    failurePolicy: "STOP",
    status: "PENDING",
    createdAt: "2026-08-23T00:00:00.000Z",
  }], {
    runId: "run-capability-replay",
    sessionId: "session-capability-replay",
    stepIndex: 0,
  });

  assert.equal(outcome.stop, false);
  assert.deepEqual({ credentialResolutions, providerCalls, dockerStarts }, {
    credentialResolutions: 0,
    providerCalls: 0,
    dockerStarts: 0,
  });
});

test("completed code capability output delegates atomic DONE ownership to the exact-result store", async () => {
  const store = new InMemorySessionStore();
  const descriptor = defaultToolCatalog.getDescriptorRef("code.execute");
  assert.ok(descriptor);
  const activation = createToolActivationRefV1({
    descriptor,
    registryGeneration: "generation-replay",
    scopeFingerprint: fingerprintToolScopeV1({
      tenant: "tenant-a",
      environment: "environment-a",
      gateway: "local-core",
      authorizationScope: ["runtime"],
    }),
  });
  const order: string[] = [];
  let exactResult: unknown;
  const originalMark = store.markEffectStatus.bind(store);
  store.markEffectStatus = async (...args) => {
    order.push("mark-done");
    return originalMark(...args);
  };
  Object.assign(store, {
    saveSandboxCapabilityEffectResult: async (input: { result: unknown }) => {
      order.push("save-exact-result");
      exactResult = structuredClone(input.result);
      await store.saveEffectResult("run-exact", "session-exact", input.result as never);
    },
  });
  const timestamp = "2026-08-23T12:00:00.000Z";
  const rawOutput = {
    status: "ok",
    capabilityReplayEvidence: {
      version: 1,
      leaseId: "lease-exact",
      bindingDigest: "a".repeat(64),
      toolCallId: "call-exact",
    },
  };
  const agentToolResult = {
    version: "v2" as const,
    toolName: "code.execute",
    status: "OK" as const,
    toolCallId: "call-exact",
    activation,
    outcome: {
      version: "v1" as const,
      callId: "call-exact",
      activation,
      kind: "success" as const,
      startedAt: timestamp,
      completedAt: timestamp,
      effectState: "not_applicable" as const,
      rawOutput,
    },
    modelContext: { text: "complete", rawOutputRef: "sha256:recorded", truncated: false },
    auditRecord: {
      toolName: "code.execute",
      input: { language: "javascript", code: "return 1" },
      output: rawOutput,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      status: "OK" as const,
    },
  };
  const registry = new EffectRegistry();
  registry.register("execute_tool_call", async () => agentToolResult);
  await new InlineEffectRunner(store, registry).runEffects([{
    runId: "run-exact",
    sessionId: "session-exact",
    stepIndex: 0,
    type: "execute_tool_call",
    payload: { toolName: "code.execute", toolInput: {} },
    idempotencyKey: "call-exact",
    failurePolicy: "STOP",
    status: "PENDING",
    createdAt: timestamp,
  }], { runId: "run-exact", sessionId: "session-exact", stepIndex: 0 });

  assert.deepEqual(order, ["save-exact-result"]);
  assert.deepEqual((exactResult as { output?: unknown }).output, agentToolResult);
});

test("execute-tool handler persists the exact completed result before returning to the effect runner", async () => {
  const order: string[] = [];
  const toolGateway = adaptLegacyTestToolGateway({
    validateInput: async (_name, input) => input,
    call: async (name, input) => {
      order.push("tool-completed");
      return buildAgentToolSuccessResult({
        toolName: name,
        input,
        output: { status: "ok" },
      });
    },
  });
  const preparedToolCall = await prepareTestToolCall({
    gateway: toolGateway,
    toolName: "code.execute",
    toolInput: { language: "javascript", code: "return 1" },
    runId: "run-handler-crash",
    sessionId: "session-handler-crash",
    callId: "call-handler-crash",
  });
  const executePreparedToolCall = toolGateway.executePreparedToolCall.bind(toolGateway);
  toolGateway.executePreparedToolCall = async (prepared, options) => {
    const result = await executePreparedToolCall(prepared, options);
    await options?.persistCompletedCapabilityResult?.(result);
    return result;
  };
  const handler = createExecuteToolCallHandler(toolGateway);
  const output = await handler({
    runId: "run-handler-crash",
    sessionId: "session-handler-crash",
    stepIndex: 0,
    type: "execute_tool_call",
    payload: { preparedToolCall },
    idempotencyKey: "call-handler-crash",
    failurePolicy: "STOP",
    status: "PENDING",
    createdAt: "2026-08-23T12:00:00.000Z",
  }, {
    runId: "run-handler-crash",
    sessionId: "session-handler-crash",
    stepIndex: 0,
    persistCompletedCapabilityResult: async () => {
      order.push("exact-result-durable");
    },
  });
  order.push("handler-returned");

  assert.equal((output as { status?: string }).status, "OK");
  assert.deepEqual(order, ["tool-completed", "exact-result-durable", "handler-returned"]);
});

test("prepared-call cleanup runs only after its durable effect exists and remains idempotent", async () => {
  const store = new InMemorySessionStore();
  const toolGateway = adaptLegacyTestToolGateway({
    validateInput: async (_name, input) => input,
    call: async () => {
      throw new Error("cleanup must not execute the prepared call");
    },
  });
  const preparedToolCall = await prepareTestToolCall({
    gateway: toolGateway,
    toolName: "code.execute",
    toolInput: { language: "javascript", code: "return 1" },
    runId: "run-cleanup",
    sessionId: "session-cleanup",
    callId: "call-cleanup",
  });
  let releases = 0;
  toolGateway.releasePreparedToolCall = async (prepared) => {
    assert.equal(prepared.callId, "call-cleanup");
    releases += 1;
  };
  const registry = new EffectRegistry();
  registry.register(
    "release_prepared_tool_call",
    createReleasePreparedToolCallHandler(toolGateway),
  );
  const runner = new InlineEffectRunner(store, registry);
  const effect = {
    runId: "run-cleanup-continuation",
    sessionId: "session-cleanup",
    stepIndex: 2,
    type: "release_prepared_tool_call",
    payload: { preparedToolCall },
    idempotencyKey: "call-cleanup:release",
    failurePolicy: "STOP" as const,
    status: "PENDING" as const,
    createdAt: "2026-08-26T12:00:00.000Z",
  };

  assert.equal(
    (await runner.runEffects([effect], {
      runId: effect.runId,
      sessionId: effect.sessionId,
      stepIndex: effect.stepIndex,
    })).stop,
    false,
  );
  assert.equal(
    (await runner.runEffects([effect], {
      runId: effect.runId,
      sessionId: effect.sessionId,
      stepIndex: effect.stepIndex,
    })).stop,
    false,
  );
  assert.equal(releases, 1);
});

test("deferred capability output mutation cannot alter or masquerade as the persisted snapshot", async () => {
  const store = new InMemorySessionStore();
  const timestamp = "2026-08-23T12:00:00.000Z";
  const original = structuredClone(agentToolResultFixture(timestamp));
  let persisted: unknown;
  Object.assign(store, {
    saveSandboxCapabilityEffectResult: async (input: { result: { output: unknown } }) => {
      await Promise.resolve();
      persisted = structuredClone(input.result.output);
      await store.saveEffectResult("run-mutation", "session-mutation", input.result as never);
    },
  });
  const registry = new EffectRegistry();
  registry.register("execute_tool_call", async (_effect, context) => {
    const mutable = structuredClone(original);
    const saving = context.persistCompletedCapabilityResult!(mutable);
    (mutable.outcome.rawOutput as { status: string }).status = "mutated";
    await saving;
    return mutable;
  });
  const result = await new InlineEffectRunner(store, registry).runEffects([{
    runId: "run-mutation", sessionId: "session-mutation", stepIndex: 0,
    type: "execute_tool_call", payload: { toolName: "code.execute", toolInput: {} },
    idempotencyKey: "call-mutation", failurePolicy: "STOP", status: "PENDING", createdAt: timestamp,
  }], { runId: "run-mutation", sessionId: "session-mutation", stepIndex: 0 });

  assert.equal(result.stop, true);
  assert.equal(((persisted as typeof original).outcome.rawOutput as { status: string }).status, "ok");
  assert.equal((((await store.getEffectResult("call-mutation"))?.output as typeof original).outcome.rawOutput as { status: string }).status, "ok");
});

test("rejected pre-cleanup capability persistence does not leave a stale conflicting candidate", async () => {
  const store = new InMemorySessionStore();
  let attempts = 0;
  Object.assign(store, {
    saveSandboxCapabilityEffectResult: async () => {
      attempts += 1;
      throw new Error("capability result is not durably replayable");
    },
  });
  const timestamp = "2026-08-23T12:00:00.000Z";
  const exact = structuredClone(agentToolResultFixture(timestamp));
  (exact.outcome.rawOutput as { status: string }).status = "timeout";
  const returned = structuredClone(exact);
  (returned.outcome.rawOutput as { status: string }).status = "error";
  const registry = new EffectRegistry();
  registry.register("execute_tool_call", async (_effect, context) => {
    await assert.rejects(context.persistCompletedCapabilityResult!(exact), /not durably replayable/u);
    return returned;
  });

  const result = await new InlineEffectRunner(store, registry).runEffects([{
    runId: "run-timeout-envelope", sessionId: "session-timeout-envelope", stepIndex: 0,
    type: "execute_tool_call", payload: { toolName: "code.execute", toolInput: {} },
    idempotencyKey: "call-mutation", failurePolicy: "STOP", status: "PENDING", createdAt: timestamp,
  }], { runId: "run-timeout-envelope", sessionId: "session-timeout-envelope", stepIndex: 0 });

  assert.equal(result.stop, true, JSON.stringify(result));
  assert.equal(attempts, 2);
  assert.doesNotMatch(JSON.stringify(result), /conflicting completed outputs/u);
});

function agentToolResultFixture(timestamp: string) {
  const descriptor = defaultToolCatalog.getDescriptorRef("code.execute");
  assert.ok(descriptor);
  const activation = createToolActivationRefV1({
    descriptor,
    registryGeneration: "generation-mutation",
    scopeFingerprint: fingerprintToolScopeV1({ tenant: "tenant-a", environment: "environment-a", gateway: "local-core", authorizationScope: ["runtime"] }),
  });
  const rawOutput = {
    status: "ok",
    capabilityReplayEvidence: { version: 1, leaseId: "lease-mutation", bindingDigest: "a".repeat(64), toolCallId: "call-mutation" },
  };
  return {
    version: "v2" as const, toolName: "code.execute", status: "OK" as const, toolCallId: "call-mutation", activation,
    outcome: { version: "v1" as const, callId: "call-mutation", activation, kind: "success" as const, startedAt: timestamp, completedAt: timestamp, effectState: "not_applicable" as const, rawOutput },
    modelContext: { text: "complete", rawOutputRef: "sha256:mutation", truncated: false },
    auditRecord: { toolName: "code.execute", input: {}, output: rawOutput, startedAt: timestamp, completedAt: timestamp, durationMs: 0, status: "OK" as const },
  };
}

test("selected but unused capability persists DONE and replays without live work", async () => {
  const store = new DurableInMemorySessionStore({ tenantId: "tenant-unused" });
  const timestamp = "2026-08-23T12:00:00.000Z";
  const binding: SandboxCapabilityLeaseBindingV1 = {
    version: 1,
    tenantId: "tenant-unused",
    environmentId: "environment-unused",
    sessionId: "session-unused",
    runId: "run-unused",
    toolCallId: "call-unused",
    profileFingerprint: "a".repeat(64),
    capabilityCatalogFingerprint: "b".repeat(64),
    executionBoundaryRevision: "boundary-unused",
    capabilityId: TAVILY_SEARCH_CAPABILITY_ID,
    operation: TAVILY_SEARCH_OPERATION,
    resource: TAVILY_SEARCH_RESOURCE,
    audience: { tenantId: "tenant-unused", environmentId: "environment-unused" },
    brokerAuthority: { authorityId: "broker-unused", revision: "broker-revision-unused" },
    credentialReference: { credentialId: "tool.tavily.default", revision: "credential-unused" },
    policyRevision: "policy-unused",
  };
  const bindingDigest = fingerprintSandboxCapabilityLeaseBindingV1(binding);
  const lease = (sequence: number, transition: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 => ({
    version: 1,
    leaseId: "lease-unused",
    sequence,
    transition,
    binding,
    bindingDigest,
    usage: { requestLimit: 1, requestsConsumed: 0, responseByteLimit: 4096, responseBytesConsumed: 0, exactProviderUsage: null },
    ...(transition === "issued" || transition === "revoked" || transition === "cleaned" ? { issuedAt: timestamp } : {}),
    expiresAt: "2026-08-23T13:00:00.000Z",
    occurredAt: `2026-08-23T12:00:0${sequence}.000Z`,
  });
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: lease(1, "requested") });
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: lease(2, "issued") });

  const descriptor = defaultToolCatalog.getDescriptorRef("code.execute");
  assert.ok(descriptor);
  const activation = createToolActivationRefV1({
    descriptor,
    registryGeneration: "generation-unused",
    scopeFingerprint: fingerprintToolScopeV1({ tenant: "tenant-unused", environment: "environment-unused", gateway: "local-core", authorizationScope: ["runtime"] }),
  });
  const rawOutput = {
    status: "ok",
    stdout: "completed without provider",
    capabilityReplayEvidence: { version: 1, leaseId: "lease-unused", bindingDigest, toolCallId: "call-unused" },
  };
  const exactToolResult = {
    version: "v2" as const,
    toolName: "code.execute",
    status: "OK" as const,
    toolCallId: "call-unused",
    activation,
    outcome: { version: "v1" as const, callId: "call-unused", activation, kind: "success" as const, startedAt: timestamp, completedAt: timestamp, effectState: "not_applicable" as const, rawOutput },
    modelContext: { text: "complete", rawOutputRef: "sha256:unused", truncated: false },
    auditRecord: { toolName: "code.execute", input: { language: "javascript", code: "console.log('done')" }, output: rawOutput, startedAt: timestamp, completedAt: timestamp, durationMs: 0, status: "OK" as const },
  };
  let credentialResolutions = 0;
  let providerCalls = 0;
  let brokerCalls = 0;
  let dockerStarts = 0;
  const registry = new EffectRegistry();
  registry.register("execute_tool_call", async (_effect, context) => {
    credentialResolutions += 1;
    providerCalls += 1;
    brokerCalls += 1;
    dockerStarts += 1;
    await context.persistCompletedCapabilityResult?.(exactToolResult);
    throw new Error("simulated crash after exact result persistence and before cleanup");
  });
  const effect = {
    runId: binding.runId,
    sessionId: binding.sessionId,
    stepIndex: 0,
    type: "execute_tool_call",
    payload: { toolName: "code.execute", toolInput: {} },
    idempotencyKey: binding.toolCallId,
    failurePolicy: "STOP" as const,
    status: "PENDING" as const,
    createdAt: timestamp,
  };
  const preparedGateway = adaptLegacyTestToolGateway({
    validateInput: async (_name, input) => input,
    call: async () => exactToolResult,
  });
  const preparedToolCall = await prepareTestToolCall({
    gateway: preparedGateway,
    toolName: "code.execute",
    toolInput: {
      language: "javascript",
      code: "console.log('done')",
      capability: { capabilityId: TAVILY_SEARCH_CAPABILITY_ID, input: { query: "unused" } },
    },
    runId: binding.runId,
    sessionId: binding.sessionId,
    callId: binding.toolCallId,
  });
  (store as unknown as { effects: Array<Record<string, unknown>> }).effects.push({
    ...effect,
    payload: { preparedToolCall },
    tenantId: binding.tenantId,
  });
  const runner = new InlineEffectRunner(store, registry);
  const completed = await runner.runEffects([effect], { runId: binding.runId, sessionId: binding.sessionId, stepIndex: 0 });
  assert.equal(completed.stop, true);
  assert.equal((await store.getEffectResult(binding.toolCallId))?.status, "DONE");
  assert.deepEqual((await store.getEffectResult(binding.toolCallId))?.output, exactToolResult);

  credentialResolutions = 0;
  providerCalls = 0;
  brokerCalls = 0;
  dockerStarts = 0;
  const replayed = await runner.runEffects([effect], { runId: binding.runId, sessionId: binding.sessionId, stepIndex: 0 });
  assert.equal(replayed.stop, false);
  assert.deepEqual({ credentialResolutions, providerCalls, brokerCalls, dockerStarts }, { credentialResolutions: 0, providerCalls: 0, brokerCalls: 0, dockerStarts: 0 });
  assert.deepEqual((await store.getEffectResult(binding.toolCallId))?.output, exactToolResult);
});

test("Effect runner honors existing FAILED result and WAIT policy", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  let handlerCalls = 0;
  registry.register("ok", async () => {
    handlerCalls += 1;
    return { ok: true };
  });

  await store.saveEffectResult("run-1", "s1", {
    idempotencyKey: "k-existing",
    status: "FAILED",
    error: {
      code: "EFFECT_EXECUTION_FAILED",
      message: "already failed",
    },
    timestamp: new Date().toISOString(),
  });

  const runner = new InlineEffectRunner(store, registry);
  const outcome = await runner.runEffects(
    [
      {
        runId: "run-1",
        sessionId: "s1",
        stepIndex: 0,
        type: "ok",
        payload: {},
        idempotencyKey: "k-existing",
        failurePolicy: "WAIT",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      runId: "run-1",
      sessionId: "s1",
      stepIndex: 0,
    },
  );

  assert.equal(outcome.stop, true);
  assert.equal(outcome.terminalStatus, "WAITING");
  assert.equal(outcome.errors.length, 1);
  assert.equal(handlerCalls, 0);
});

test("Effect runner executes the prepared managed-worktree activation without re-resolution", async () => {
  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("s-managed", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "s-managed",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        exec: {
          managedWorktreeBinding: {
            status: "bound",
            sessionId: "s-managed",
            runId: "run-managed",
            worktreeRoot: "/trusted-worktree",
            leaseId: "lease-1",
          },
        },
      },
    },
  });

  const execInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: true,
      },
      devShellService: {
        runCommand: async (input: unknown) => {
          execInputs.push(input as Record<string, unknown>);
          return {
            submittedAt: "2026-01-01T00:00:00.000Z",
            status: "COMPLETED",
            stdout: "ok\n",
            text: "ok\n",
            truncated: false,
          };
        },
      } as never,
    },
    mcpManager: {
      refresh: async () => ({
        healthy: true,
        checkedAt: new Date().toISOString(),
        servers: [],
        tools: [],
      }),
      assertHealthy: async () => {},
      callTool: async () => {
        throw new Error("unexpected MCP tool call");
      },
      close: async () => {},
    },
  });
  await registry.refresh();

  const registryEffects = new EffectRegistry();
  registryEffects.register("execute_tool_call", createExecuteToolCallHandler(registry));
  const runner = new InlineEffectRunner(store, registryEffects);
  const preparedSession = await store.getSession("s-managed");
  assert.ok(preparedSession);
  const runtimePayload = {
    workspace: {
      managedWorktree: true,
      workspaceRoot: "/trusted-worktree",
      leaseId: "lease-1",
    },
  };
  const preparedToolCall = await prepareTestToolCall({
    gateway: registry,
    toolName: "dev.shell.run",
    toolInput: {
      command: "echo ok",
      workspaceRoot: ".",
    },
    runId: "run-managed",
    sessionId: "s-managed",
    callId: "managed-effect-1",
    options: {
      runContext: {
        runId: "run-managed",
        sessionId: "s-managed",
        payload: runtimePayload,
        sessionState: preparedSession.state,
      },
    },
  });

  const outcome = await runner.runEffects(
    [
      {
        runId: "run-managed",
        sessionId: "s-managed",
        stepIndex: 0,
        type: "execute_tool_call",
        payload: {
          preparedToolCall,
          runtimePayload,
        },
        idempotencyKey: "managed-effect-1",
        failurePolicy: "STOP",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      runId: "run-managed",
      sessionId: "s-managed",
      stepIndex: 0,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(execInputs.length, 1);
  assert.equal(execInputs[0]?.sourceWriteAuthority, "source_write");
  assert.deepEqual(execInputs[0]?.sourceWriteGuard, {
    enabled: true,
    managedWorktree: true,
    approvalGrants: [],
  });
});

test("Effect runner clamps durable dev.shell.run timeout against runtime budget", async () => {
  const store = new InMemorySessionStore();
  const calls: Array<Record<string, unknown>> = [];
  const registryEffects = new EffectRegistry();
  const toolGateway = adaptLegacyTestToolGateway({
    validateInput: async (_name, input) => input,
    call: async (name: string, input: unknown) => {
      calls.push(input as Record<string, unknown>);
      return buildAgentToolSuccessResult({
        toolName: name,
        input,
        output: {
        status: "COMPLETED",
        stdout: "ok\n",
        text: "ok\n",
        truncated: false,
        },
      });
    },
  });
  registryEffects.register("execute_tool_call", createExecuteToolCallHandler(toolGateway));
  const runner = new InlineEffectRunner(store, registryEffects);
  const preparedToolCall = await prepareTestToolCall({
    gateway: toolGateway,
    toolName: "dev.shell.run",
    toolInput: {
      command: "python3 train.py",
      workspaceRoot: "/app",
      timeoutMs: 240_000,
    },
    runId: "run-budget",
    sessionId: "s-budget",
    callId: "budget-effect-1",
    options: { runtimeBudgetRemainingMs: 95_000 },
  });

  const outcome = await runner.runEffects(
    [
      {
        runId: "run-budget",
        sessionId: "s-budget",
        stepIndex: 0,
        type: "execute_tool_call",
        payload: {
          preparedToolCall,
          runtimePayload: {},
        },
        idempotencyKey: "budget-effect-1",
        failurePolicy: "STOP",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      runId: "run-budget",
      sessionId: "s-budget",
      stepIndex: 0,
      runtimeBudgetRemainingMs: 95_000,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "python3 train.py");
  assert.equal(typeof calls[0]?.timeoutMs, "number");
  assert.ok((calls[0]?.timeoutMs as number) <= 35_000);
  assert.ok((calls[0]?.timeoutMs as number) > 30_000);
});
