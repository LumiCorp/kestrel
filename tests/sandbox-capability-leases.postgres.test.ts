import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";
import {
  fingerprintSandboxCapabilityLeaseBindingV1,
  TAVILY_SEARCH_CAPABILITY_ID,
  TAVILY_SEARCH_OPERATION,
  TAVILY_SEARCH_RESOURCE,
  type SandboxCapabilityLeaseBindingV1,
  type SandboxCapabilityChildReservationV1,
  type SandboxCapabilityLeaseTransitionRecordV1,
} from "../src/kestrel/contracts/sandbox-capability.js";
import { SandboxCapabilityExactResultConflictError } from "../src/kestrel/contracts/store.js";
import { PgSqlExecutor } from "../src/store/PgSqlExecutor.js";
import { PostgresSessionStore } from "../src/store/PostgresSessionStore.js";
import { createTestToolGateway, prepareTestToolCall } from "./helpers/createTestToolGateway.js";

const databaseUrl = process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL?.trim();

test("PostgreSQL capability lease ledger serializes CAS transitions and preserves immutable evidence", async () => {
  assert.ok(databaseUrl, "KESTREL_PRODUCT_RUNNER_DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const store = new PostgresSessionStore(new PgSqlExecutor(pool), { tenantId: "tenant-pg" });
  const suffix = randomUUID();
  const sessionId = `lease-session-${suffix}`;
  const runId = `lease-run-${suffix}`;
  const leaseId = `lease-${suffix}`;
  const binding: SandboxCapabilityLeaseBindingV1 = {
    version: 1, tenantId: "tenant-pg", environmentId: "env-pg", sessionId, runId, toolCallId: `call-${suffix}`,
    profileFingerprint: "a".repeat(64), capabilityCatalogFingerprint: "b".repeat(64), executionBoundaryRevision: "boundary-r1",
    capabilityId: TAVILY_SEARCH_CAPABILITY_ID, operation: TAVILY_SEARCH_OPERATION, resource: TAVILY_SEARCH_RESOURCE,
    audience: { tenantId: "tenant-pg", environmentId: "env-pg" }, brokerAuthority: { authorityId: "broker", revision: "r1" },
    credentialReference: { credentialId: "tool.tavily.default", revision: "credential-r1" }, policyRevision: "policy-r1",
  };
  const record = (sequence: number, transition: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 => ({
    version: 1, leaseId, sequence, transition, binding, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding),
    usage: { requestLimit: 1, requestsConsumed: 0, responseByteLimit: 4096, responseBytesConsumed: 0, exactProviderUsage: null },
    expiresAt: "2026-08-23T12:05:00.000Z", occurredAt: `2026-08-23T12:00:0${sequence}.000Z`,
    ...(transition === "issued" || transition === "invoking" ? { issuedAt: "2026-08-23T12:00:02.000Z" } : {}),
  });
  try {
    await store.ensureSession(sessionId);
    await store.startRun(runId, { id: `event-${suffix}`, type: "user.message", sessionId, payload: {}, timestamp: "2026-08-23T12:00:00.000Z" });
    const gateway = createTestToolGateway({ "code.execute": async () => ({ status: "ok" }) });
    const preparedToolCall = await prepareTestToolCall({
      gateway,
      toolName: "code.execute",
      toolInput: {
        language: "javascript",
        code: "console.log('ok')",
        capability: { capabilityId: TAVILY_SEARCH_CAPABILITY_ID, input: { query: "ok" } },
      },
      runId,
      sessionId,
      callId: binding.toolCallId,
    });
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json, idempotency_key, failure_policy, status, created_at, tenant_id)
       VALUES ($1, $2, 1, 'execute_tool_call', $3::jsonb, $4, 'STOP', 'PENDING', NOW(), $5)`,
      [runId, sessionId, JSON.stringify({ preparedToolCall }), binding.toolCallId, binding.tenantId],
    );
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: record(1, "requested") });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: record(2, "issued") });
    const contention = await Promise.allSettled([
      store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 2, record: record(3, "invoking") }),
      store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 2, record: record(3, "invoking") }),
    ]);
    assert.equal(contention.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(contention.filter((item) => item.status === "rejected").length, 1);
    assert.equal((await store.getSandboxCapabilityLease(leaseId))?.transition, "invoking");
    assert.deepEqual((await store.listSandboxCapabilityLeaseTransitions(leaseId)).map((item) => item.sequence), [1, 2, 3]);
    assert.deepEqual((await store.listRecoverableSandboxCapabilityLeases({ before: "2026-08-23T12:01:00.000Z" })).filter((item) => item.leaseId === leaseId).map((item) => item.transition), ["invoking"]);
    const exactEffectResult = {
      idempotencyKey: binding.toolCallId,
      status: "DONE" as const,
      output: {
        version: "v2",
        toolName: "code.execute",
        status: "OK",
        toolCallId: binding.toolCallId,
        activation: preparedToolCall.activation,
        outcome: {
          version: "v1", callId: binding.toolCallId, activation: preparedToolCall.activation,
          kind: "success", startedAt: "2026-08-23T12:00:03.000Z", completedAt: "2026-08-23T12:00:04.000Z",
          effectState: "not_applicable",
          rawOutput: {
            answer: "recorded",
            capabilityReplayEvidence: {
              version: 1,
              leaseId,
              bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding),
              toolCallId: binding.toolCallId,
            },
          },
        },
        modelContext: { text: "recorded", rawOutputRef: "sha256:recorded", truncated: false },
        auditRecord: {
          toolName: "code.execute", input: preparedToolCall.effectiveInput, output: { answer: "recorded" },
          startedAt: "2026-08-23T12:00:03.000Z", completedAt: "2026-08-23T12:00:04.000Z", durationMs: 1000, status: "OK",
        },
      },
      timestamp: "2026-08-23T12:00:04.000Z",
    };
    await assert.rejects(store.saveSandboxCapabilityEffectResult({
      leaseId, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding), toolCallId: binding.toolCallId,
      runId, sessionId, result: exactEffectResult,
    }), /completed exact lease action/u);
    await store.appendSandboxCapabilityLeaseTransition({
      expectedSequence: 3,
      record: {
        ...record(4, "consumed"),
        issuedAt: "2026-08-23T12:00:02.000Z",
        usage: { ...record(4, "consumed").usage, requestsConsumed: 1, responseBytesConsumed: 18 },
        terminalOutcome: "completed",
        result: { digest: "d".repeat(64), reference: "artifact:provider-result" },
      },
    });
    let releasePausedInsert!: () => void;
    let markInsertStarted!: () => void;
    const pausedInsert = new Promise<void>((resolve) => { releasePausedInsert = resolve; });
    const insertStarted = new Promise<void>((resolve) => { markInsertStarted = resolve; });
    const baseExecutor = new PgSqlExecutor(pool);
    const pausingStore = new PostgresSessionStore({
      query: baseExecutor.query.bind(baseExecutor),
      transaction: (operation) => baseExecutor.transaction((executor) => operation({
        query: async (text, values) => {
          if (/INSERT INTO effect_results/u.test(text)) {
            markInsertStarted();
            await pausedInsert;
          }
          return executor.query(text, values);
        },
      })),
    }, { tenantId: binding.tenantId });
    const cancelledSave = new AbortController();
    const cancelledPersistence = pausingStore.saveSandboxCapabilityEffectResult({
      leaseId, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding), toolCallId: binding.toolCallId,
      runId, sessionId, result: exactEffectResult, signal: cancelledSave.signal,
    });
    await insertStarted;
    cancelledSave.abort();
    releasePausedInsert();
    await assert.rejects(cancelledPersistence, /cancelled/u);
    assert.equal(await store.getEffectResult(binding.toolCallId), null);
    const completedLease = await store.getSandboxCapabilityLease(leaseId);
    assert.ok(completedLease);
    await store.appendSandboxCapabilityLeaseTransition({
      expectedSequence: 4,
      record: {
        ...completedLease,
        sequence: 5,
        transition: "cleaned",
        cleanedAt: "2026-08-23T12:00:05.000Z",
        occurredAt: "2026-08-23T12:00:05.000Z",
      },
    });
    const mutableExactEffectResult = structuredClone(exactEffectResult);
    const savingExactEffectResult = store.saveSandboxCapabilityEffectResult({
      leaseId, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding), toolCallId: binding.toolCallId,
      runId, sessionId, result: mutableExactEffectResult,
    });
    ((mutableExactEffectResult.output as { outcome: { rawOutput: { answer: string } } }).outcome.rawOutput).answer = "mutated-after-save-started";
    await savingExactEffectResult;
    assert.deepEqual(await store.getEffectResult(binding.toolCallId), exactEffectResult);
    const wrongTenantStore = new PostgresSessionStore(new PgSqlExecutor(pool), { tenantId: "tenant-other" });
    await assert.rejects(
      wrongTenantStore.saveEffectResult(runId, sessionId, exactEffectResult),
      /tenant does not match/u,
    );
    await assert.rejects(
      store.saveEffectResult("run-wrong", sessionId, exactEffectResult),
      /owner does not match/u,
    );
    await assert.rejects(
      store.saveEffectResult(runId, "session-wrong", exactEffectResult),
      /owner does not match/u,
    );
    await assert.rejects(
      store.markEffectStatus(binding.toolCallId, "DONE", { runId: "run-wrong", sessionId }),
      /owner or tenant does not match/u,
    );
    await assert.rejects(
      store.markEffectStatus(binding.toolCallId, "DONE", { runId, sessionId: "session-wrong" }),
      /owner or tenant does not match/u,
    );
    await assert.rejects(
      wrongTenantStore.markEffectStatus(binding.toolCallId, "DONE", { runId, sessionId }),
      /owner or tenant does not match/u,
    );
    await assert.rejects(
      wrongTenantStore.saveSandboxCapabilityEffectResult({
        leaseId, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding),
        toolCallId: binding.toolCallId, runId, sessionId, result: exactEffectResult,
      }),
      /tenant does not match/u,
    );
    await assert.rejects(
      store.saveSandboxCapabilityEffectResult({
        leaseId, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding),
        toolCallId: binding.toolCallId, runId: "run-wrong", sessionId, result: exactEffectResult,
      }),
      /no matching prepared effect/u,
    );
    await assert.rejects(
      store.saveSandboxCapabilityEffectResult({
        leaseId, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding),
        toolCallId: binding.toolCallId, runId, sessionId: "session-wrong", result: exactEffectResult,
      }),
      /no matching prepared effect/u,
    );
    assert.deepEqual(await store.getEffectResult(binding.toolCallId), exactEffectResult);
    assert.equal((await store.getPersistedEffect(binding.toolCallId))?.status, "PENDING");
    assert.deepEqual(await store.claimExactEffectCancellation({
      sessionId, runId, idempotencyKey: binding.toolCallId, tenantId: "tenant-other",
    }), { status: "not_found" });
    assert.deepEqual(await store.getEffectResult(binding.toolCallId), exactEffectResult);
    assert.deepEqual(await store.claimExactEffectCancellation({
      sessionId, runId, idempotencyKey: binding.toolCallId, tenantId: binding.tenantId,
    }), { status: "completed" });
    const cancelledToolCallId = `cancelled-call-${suffix}`;
    const cancelledLeaseId = `cancelled-lease-${suffix}`;
    const cancelledBinding = { ...binding, toolCallId: cancelledToolCallId };
    const cancelledRecord = (
      sequence: number,
      transition: SandboxCapabilityLeaseTransitionRecordV1["transition"],
    ): SandboxCapabilityLeaseTransitionRecordV1 => ({
      ...record(sequence, transition),
      leaseId: cancelledLeaseId,
      binding: cancelledBinding,
      bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(cancelledBinding),
    });
    const cancelledPreparedToolCall = await prepareTestToolCall({
      gateway,
      toolName: "code.execute",
      toolInput: {
        language: "javascript",
        code: "console.log('cancel')",
        capability: { capabilityId: TAVILY_SEARCH_CAPABILITY_ID, input: { query: "cancel" } },
      },
      runId,
      sessionId,
      callId: cancelledToolCallId,
    });
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json, idempotency_key, failure_policy, status, created_at, tenant_id)
       VALUES ($1, $2, 1, 'execute_tool_call', $3::jsonb, $4, 'STOP', 'PENDING', NOW(), $5)`,
      [runId, sessionId, JSON.stringify({ preparedToolCall: cancelledPreparedToolCall }), cancelledToolCallId, binding.tenantId],
    );
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: cancelledRecord(1, "requested") });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: cancelledRecord(2, "issued") });
    assert.deepEqual(await store.claimExactEffectCancellation({
      sessionId, runId, idempotencyKey: cancelledToolCallId, tenantId: "tenant-other",
    }), { status: "not_found" });
    assert.equal((await store.getPersistedEffect(cancelledToolCallId))?.status, "PENDING");
    assert.deepEqual(await store.claimExactEffectCancellation({
      sessionId, runId, idempotencyKey: cancelledToolCallId, tenantId: binding.tenantId,
    }), { status: "cancelled" });
    await assert.rejects(store.saveEffectResult(runId, sessionId, {
      ...exactEffectResult,
      idempotencyKey: cancelledToolCallId,
    }), /durable cancellation/u);
    await store.saveEffectResult(runId, sessionId, {
      idempotencyKey: cancelledToolCallId,
      status: "FAILED",
      error: { code: "EFFECT_EXECUTION_FAILED", message: "cancelled" },
      timestamp: "2026-08-23T12:00:04.000Z",
    });
    await assert.rejects(store.markEffectStatus(cancelledToolCallId, "DONE", { runId, sessionId }), /durable cancellation/u);
    await assert.rejects(store.saveSandboxCapabilityEffectResult({
      leaseId,
      bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding),
      toolCallId: cancelledToolCallId,
      runId,
      sessionId,
      result: { ...exactEffectResult, idempotencyKey: cancelledToolCallId },
    }), /cancelled/u);
    const abortAfterCommit = new AbortController();
    abortAfterCommit.abort();
    await store.saveSandboxCapabilityEffectResult({
      leaseId, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding), toolCallId: binding.toolCallId,
      runId, sessionId, result: exactEffectResult, signal: abortAfterCommit.signal,
    });
    await assert.rejects(store.saveSandboxCapabilityEffectResult({
      leaseId, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding), toolCallId: binding.toolCallId,
      runId, sessionId,
      result: { ...exactEffectResult, output: { status: "OK", outcome: { kind: "success", rawOutput: { answer: "losing output" } } } },
      signal: abortAfterCommit.signal,
    }), (error) => error instanceof SandboxCapabilityExactResultConflictError);
    const unusedLeaseId = `unused-lease-${suffix}`;
    const unusedBinding = { ...binding, toolCallId: `unused-call-${suffix}` };
    const unusedDigest = fingerprintSandboxCapabilityLeaseBindingV1(unusedBinding);
    const unusedRecord = (sequence: number, transition: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 => ({
      ...record(sequence, transition),
      leaseId: unusedLeaseId,
      binding: unusedBinding,
      bindingDigest: unusedDigest,
      ...(transition === "issued" || transition === "revoked" || transition === "cleaned"
        ? { issuedAt: "2026-08-23T12:00:02.000Z" }
        : {}),
    });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: unusedRecord(1, "requested") });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: unusedRecord(2, "issued") });
    const unusedPreparedToolCall = await prepareTestToolCall({
      gateway,
      toolName: "code.execute",
      toolInput: {
        language: "javascript",
        code: "console.log('unused')",
        capability: { capabilityId: TAVILY_SEARCH_CAPABILITY_ID, input: { query: "unused" } },
      },
      runId,
      sessionId,
      callId: unusedBinding.toolCallId,
    });
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json, idempotency_key, failure_policy, status, created_at, tenant_id)
       VALUES ($1, $2, 1, 'execute_tool_call', $3::jsonb, $4, 'STOP', 'PENDING', NOW(), $5)`,
      [runId, sessionId, JSON.stringify({ preparedToolCall: unusedPreparedToolCall }), unusedBinding.toolCallId, binding.tenantId],
    );
    const unusedEffectResult = {
      ...exactEffectResult,
      idempotencyKey: unusedBinding.toolCallId,
      output: {
        ...exactEffectResult.output,
        toolCallId: unusedBinding.toolCallId,
        activation: unusedPreparedToolCall.activation,
        outcome: {
          ...exactEffectResult.output.outcome,
          callId: unusedBinding.toolCallId,
          activation: unusedPreparedToolCall.activation,
          rawOutput: {
            status: "ok",
            stdout: "unused",
            capabilityReplayEvidence: {
              version: 1,
              leaseId: unusedLeaseId,
              bindingDigest: unusedDigest,
              toolCallId: unusedBinding.toolCallId,
            },
          },
        },
        auditRecord: {
          ...exactEffectResult.output.auditRecord,
          input: unusedPreparedToolCall.effectiveInput,
          output: { status: "ok", stdout: "unused" },
        },
      },
      timestamp: "2026-08-23T12:00:05.000Z",
    };
    await store.saveSandboxCapabilityEffectResult({
      leaseId: unusedLeaseId, bindingDigest: unusedDigest, toolCallId: unusedBinding.toolCallId,
      runId, sessionId, result: unusedEffectResult,
    });
    // Simulate a process crash before lease cleanup by discarding the writer
    // instance. A fresh store must observe the exact enclosing result without
    // invoking any live runtime surface.
    const restartedStore = new PostgresSessionStore(new PgSqlExecutor(pool), { tenantId: binding.tenantId });
    assert.deepEqual(await restartedStore.getEffectResult(unusedBinding.toolCallId), unusedEffectResult);
    await store.appendSandboxCapabilityLeaseTransition({
      expectedSequence: 2,
      record: {
        ...unusedRecord(3, "revoked"),
        terminalOutcome: "failed",
        terminalReason: "container_teardown_completed",
      },
    });
    await store.appendSandboxCapabilityLeaseTransition({
      expectedSequence: 3,
      record: {
        ...unusedRecord(4, "cleaned"),
        terminalOutcome: "failed",
        terminalReason: "container_teardown_completed",
        cleanedAt: "2026-08-23T12:00:04.000Z",
      },
    });
    assert.deepEqual(await store.getEffectResult(unusedBinding.toolCallId), unusedEffectResult);
    const childParentId = `child-parent-${suffix}`;
    const childParentBinding = { ...binding, toolCallId: `child-parent-call-${suffix}` };
    const childParentDigest = fingerprintSandboxCapabilityLeaseBindingV1(childParentBinding);
    const childParentRecord = (sequence: number, transition: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 => ({ ...record(sequence, transition), leaseId: childParentId, binding: childParentBinding, bindingDigest: childParentDigest });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: childParentRecord(1, "requested") });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: childParentRecord(2, "issued") });
    const child = (id: string, parentLeaseId = childParentId, parentBindingDigest = childParentDigest): SandboxCapabilityChildReservationV1 => ({ version: 1, reservationId: `${id}-${suffix}`, sequence: 1, status: "reserved", decision: { version: 1, decisionId: `decision-${id}-${suffix}`, parentLeaseId, parentBindingDigest, childSessionId: `child-session-${id}`, childRunId: `child-run-${id}`, childToolCallId: `child-call-${id}`, policyRevision: `policy-${id}`, approval: { approvalId: `approval-${id}`, authorityRevision: `authority-${id}` }, requestLimit: 1, responseByteLimit: 4096, decidedAt: "2026-08-23T12:00:03.000Z" }, requestsCommitted: 0, responseBytesCommitted: 0, occurredAt: "2026-08-23T12:00:03.000Z" });
    const childContention = await Promise.allSettled([store.reserveSandboxCapabilityChild({ expectedParentSequence: 2, reservation: child("a") }), store.reserveSandboxCapabilityChild({ expectedParentSequence: 2, reservation: child("b") })]);
    assert.equal(childContention.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(childContention.filter((item) => item.status === "rejected").length, 1);
    const reserved = (await store.listSandboxCapabilityChildReservations(childParentId))[0]!;
    await assert.rejects(store.reserveSandboxCapabilityInvocation({ expectedSequence: 2, record: { ...childParentRecord(3, "invoking"), usage: { ...childParentRecord(3, "invoking").usage, requestsConsumed: 1 } } }), /reserved by child authority/u);
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 2, record: { ...childParentRecord(3, "revoked"), terminalOutcome: "revoked" } });
    assert.equal((await store.getSandboxCapabilityChildReservation(reserved.reservationId))?.status, "revoked");

    const raceParentId = `race-parent-${suffix}`;
    const raceBinding = { ...binding, toolCallId: `race-parent-call-${suffix}` };
    const raceDigest = fingerprintSandboxCapabilityLeaseBindingV1(raceBinding);
    const raceRecord = (sequence: number, transition: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 => ({ ...record(sequence, transition), leaseId: raceParentId, binding: raceBinding, bindingDigest: raceDigest });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: raceRecord(1, "requested") });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: raceRecord(2, "issued") });
    const parentChildRace = await Promise.allSettled([
      store.reserveSandboxCapabilityInvocation({ expectedSequence: 2, record: { ...raceRecord(3, "invoking"), usage: { ...raceRecord(3, "invoking").usage, requestsConsumed: 1 } } }),
      store.reserveSandboxCapabilityChild({ expectedParentSequence: 2, reservation: child("race-child", raceParentId, raceDigest) }),
    ]);
    assert.equal(parentChildRace.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(parentChildRace.filter((item) => item.status === "rejected").length, 1);

    const atomicParentId = `atomic-parent-${suffix}`;
    const atomicParentBinding = { ...binding, toolCallId: `atomic-parent-call-${suffix}` };
    const atomicParentDigest = fingerprintSandboxCapabilityLeaseBindingV1(atomicParentBinding);
    const atomicParentRecord = (sequence: number, transition: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 => ({ ...record(sequence, transition), leaseId: atomicParentId, binding: atomicParentBinding, bindingDigest: atomicParentDigest });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: atomicParentRecord(1, "requested") });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: atomicParentRecord(2, "issued") });
    const atomicChildId = `atomic-child-${suffix}`;
    const atomicReservation = child("atomic-rollback", atomicParentId, atomicParentDigest);
    const atomicChildBinding: SandboxCapabilityLeaseBindingV1 = { ...binding, toolCallId: `atomic-child-call-${suffix}`, approval: atomicReservation.decision.approval, parentAuthorization: { leaseId: atomicParentId, bindingDigest: atomicParentDigest, authorizationDecisionId: atomicReservation.decision.decisionId, reservationId: atomicReservation.reservationId, requestLimit: 1, responseByteLimit: 4096 } };
    const atomicChildDigest = fingerprintSandboxCapabilityLeaseBindingV1(atomicChildBinding);
    const atomicChildRecord = (sequence: number, transition: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 => ({ ...record(sequence, transition), leaseId: atomicChildId, binding: atomicChildBinding, bindingDigest: atomicChildDigest });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: atomicChildRecord(1, "requested") });
    await assert.rejects(store.issueSandboxCapabilityLease({ expectedSequence: 99, record: atomicChildRecord(2, "issued"), childReservation: atomicReservation }), /sequence conflict/u);
    assert.equal(await store.getSandboxCapabilityChildReservation(atomicReservation.reservationId), null);
    assert.equal((await store.getSandboxCapabilityLease(atomicChildId))?.transition, "requested");

    const byteParentId = `byte-parent-${suffix}`;
    const byteBinding = { ...binding, toolCallId: `byte-parent-call-${suffix}` };
    const byteDigest = fingerprintSandboxCapabilityLeaseBindingV1(byteBinding);
    const byteRecord = (sequence: number, transition: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 => ({
      ...record(sequence, transition), leaseId: byteParentId, binding: byteBinding, bindingDigest: byteDigest,
      usage: { requestLimit: 2, requestsConsumed: transition === "invoking" ? 1 : 0, responseByteLimit: 100, responseBytesConsumed: 0, exactProviderUsage: null },
    });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: byteRecord(1, "requested") });
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: byteRecord(2, "issued") });
    const byteChild = { ...child("byte-child", byteParentId, byteDigest), decision: { ...child("byte-child", byteParentId, byteDigest).decision, responseByteLimit: 50 } };
    await store.reserveSandboxCapabilityChild({ expectedParentSequence: 2, reservation: byteChild });
    const byteInvocation = await store.reserveSandboxCapabilityInvocation({ expectedSequence: 2, record: byteRecord(3, "invoking") });
    assert.equal(byteInvocation.invocationResponseByteLimit, 50);
  } finally {
    await pool.query("DELETE FROM runs WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    await pool.end();
  }
});
