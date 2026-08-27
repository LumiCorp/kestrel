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
import { hashCanonical } from "../src/kestrel/contracts/tool-contract.js";
import { SandboxCapabilityExactResultConflictError } from "../src/kestrel/contracts/store.js";
import { PgSqlExecutor } from "../src/store/PgSqlExecutor.js";
import { PostgresSessionStore } from "../src/store/PostgresSessionStore.js";
import {
  buildPreparedApprovalCleanupDoneEvidenceQuarantineEvent,
  PREPARED_APPROVAL_CLEANUP_QUARANTINE_AUDIT_MAX_METADATA_BYTES,
} from "../src/runtime/preparedApprovalCleanupAudit.js";
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
         (run_id, session_id, step_index, effect_type, payload_json, idempotency_key, failure_policy, status, created_at, tenant_id, tenant_ownership_state)
       VALUES ($1, $2, 1, 'execute_tool_call', $3::jsonb, $4, 'STOP', 'PENDING', NOW(), $5, 'tenant_bound')`,
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
    await pool.query(
      `UPDATE effects SET tenant_id = NULL, tenant_ownership_state = 'explicit_unbound' WHERE idempotency_key = $1`,
      [binding.toolCallId],
    );
    assert.deepEqual(await store.claimExactEffectCancellation({
      sessionId, runId, idempotencyKey: binding.toolCallId, tenantId: binding.tenantId,
    }), { status: "conflict" });
    await assert.rejects(store.saveSandboxCapabilityEffectResult({
      leaseId, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding), toolCallId: binding.toolCallId,
      runId, sessionId, result: exactEffectResult,
    }), /tenant does not match/u);
    await pool.query(
      `UPDATE effects SET tenant_ownership_state = 'tenant_bound' WHERE idempotency_key = $1`,
      [binding.toolCallId],
    );
    assert.deepEqual(await store.claimExactEffectCancellation({
      sessionId, runId, idempotencyKey: binding.toolCallId, tenantId: binding.tenantId,
    }), { status: "conflict" });
    await pool.query(
      `UPDATE effects SET tenant_id = $2, tenant_ownership_state = 'legacy_unknown' WHERE idempotency_key = $1`,
      [binding.toolCallId, binding.tenantId],
    );
    assert.deepEqual(await store.claimExactEffectCancellation({
      sessionId, runId, idempotencyKey: binding.toolCallId, tenantId: binding.tenantId,
    }), { status: "conflict" });
    await pool.query(
      `UPDATE effects SET tenant_id = $2, tenant_ownership_state = 'tenant_bound' WHERE idempotency_key = $1`,
      [binding.toolCallId, binding.tenantId],
    );
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
    assert.equal((await store.getPersistedEffect(binding.toolCallId))?.status, "DONE");
    await store.markEffectStatus(binding.toolCallId, "FAILED", {
      runId,
      sessionId,
    });
    assert.equal(
      (await store.getPersistedEffect(binding.toolCallId))?.status,
      "DONE",
      "an exact durable DONE result must prevent a later FAILED downgrade",
    );
    await pool.query(`UPDATE effects SET status = 'PENDING' WHERE idempotency_key = $1`, [binding.toolCallId]);
    const abortedIdempotentSave = new AbortController();
    abortedIdempotentSave.abort();
    await store.saveSandboxCapabilityEffectResult({
      leaseId, bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding),
      toolCallId: binding.toolCallId, runId, sessionId, result: exactEffectResult,
      signal: abortedIdempotentSave.signal,
    });
    assert.equal((await store.getPersistedEffect(binding.toolCallId))?.status, "DONE");
    assert.equal((await store.readExactEffectResult({
      sessionId,
      runId,
      idempotencyKey: binding.toolCallId,
      tenantId: binding.tenantId,
    })).status, "found");
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
      store.markEffectStatus(binding.toolCallId, "FAILED", { runId: "run-wrong", sessionId }),
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
      wrongTenantStore.markEffectStatus(binding.toolCallId, "FAILED", { runId, sessionId }),
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
    assert.equal((await store.getPersistedEffect(binding.toolCallId))?.status, "DONE");
    assert.deepEqual(await store.claimExactEffectCancellation({
      sessionId, runId, idempotencyKey: binding.toolCallId, tenantId: "tenant-other",
    }), { status: "not_found" });
    assert.deepEqual(await store.getEffectResult(binding.toolCallId), exactEffectResult);
    assert.deepEqual(await store.claimExactEffectCancellation({
      sessionId, runId, idempotencyKey: binding.toolCallId, tenantId: binding.tenantId,
    }), { status: "completed" });
    const cleanupPreparedToolCall = await prepareTestToolCall({
      gateway,
      toolName: "code.execute",
      toolInput: { language: "javascript", code: "return 1" },
      runId,
      sessionId,
      callId: `cleanup-prepared-${suffix}`,
    });
    const cleanupEffectId = `${cleanupPreparedToolCall.callId}:release`;
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json,
          idempotency_key, failure_policy, status, created_at, tenant_id,
          tenant_ownership_state)
       VALUES ($1, $2, 2, 'release_prepared_tool_call', $3::jsonb, $4,
               'STOP', 'CLAIMED', NOW(), $5, 'tenant_bound')`,
      [
        runId,
        sessionId,
        JSON.stringify({
          preparedToolCall: cleanupPreparedToolCall,
          preparedApprovalCleanup: {
            version: "runner_prepared_approval_cleanup_v1",
            organizationId: binding.tenantId,
            threadId: sessionId,
            turnId: `cleanup-turn-${suffix}`,
            interactionId: `cleanup-interaction-${suffix}`,
            requestId: `cleanup-request-${suffix}`,
            failureCode: "EXTERNAL_APPROVAL_EXPIRED",
            failureMessage: "Expired.",
          },
        }),
        cleanupEffectId,
        binding.tenantId,
      ],
    );
    const cleanupOwner = { runId, sessionId };
    await store.saveEffectResult(runId, sessionId, {
      idempotencyKey: cleanupEffectId,
      status: "FAILED",
      error: {
        code: "EFFECT_EXECUTION_FAILED",
        message: "first runner failed",
      },
      timestamp: "2026-08-27T00:00:01.000Z",
    });
    await store.markEffectStatus(cleanupEffectId, "FAILED", cleanupOwner);
    await Promise.all([
      store.commitPreparedApprovalCleanupEffectDone(
        cleanupEffectId,
        cleanupOwner,
        {
          idempotencyKey: cleanupEffectId,
          status: "DONE",
          output: {
            releasedPreparedInvocationId: cleanupPreparedToolCall.callId,
          },
          timestamp: "2026-08-27T00:00:02.000Z",
        },
      ),
      (async () => {
        await store.saveEffectResult(runId, sessionId, {
          idempotencyKey: cleanupEffectId,
          status: "FAILED",
          error: {
            code: "EFFECT_EXECUTION_FAILED",
            message: "stale runner failed",
          },
          timestamp: "2026-08-27T00:00:03.000Z",
        });
        await store.markEffectStatus(
          cleanupEffectId,
          "FAILED",
          cleanupOwner,
        );
      })(),
    ]);
    assert.equal(
      (await store.getPersistedEffect(cleanupEffectId))?.status,
      "DONE",
    );
    assert.deepEqual(await store.getEffectResult(cleanupEffectId), {
      idempotencyKey: cleanupEffectId,
      status: "DONE",
      output: {
        releasedPreparedInvocationId: cleanupPreparedToolCall.callId,
      },
      timestamp: "2026-08-27T00:00:02.000Z",
    });
    await Promise.all([
      "2026-08-27T00:00:04.000Z",
      "2026-08-27T00:00:05.000Z",
    ].map((timestamp) =>
      store.commitPreparedApprovalCleanupEffectDone(
        cleanupEffectId,
        cleanupOwner,
        {
          idempotencyKey: cleanupEffectId,
          status: "DONE",
          output: {
            releasedPreparedInvocationId: cleanupPreparedToolCall.callId,
          },
          timestamp,
        },
      )
    ));
    assert.equal(
      (await store.getEffectResult(cleanupEffectId))?.timestamp,
      "2026-08-27T00:00:02.000Z",
      "same-output success must preserve the first exact DONE evidence",
    );
    const immutableCleanupResult = await store.getEffectResult(cleanupEffectId);
    assert.equal(
      await store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
        cleanupEffectId,
        cleanupOwner,
      ),
      "done",
    );
    assert.deepEqual(
      await store.getEffectResult(cleanupEffectId),
      immutableCleanupResult,
    );
    await assert.rejects(
      store.commitPreparedApprovalCleanupEffectDone(
        cleanupEffectId,
        { runId: "wrong-run", sessionId },
        {
          idempotencyKey: cleanupEffectId,
          status: "DONE",
          output: {
            releasedPreparedInvocationId: cleanupPreparedToolCall.callId,
          },
          timestamp: "2026-08-27T00:00:04.000Z",
        },
      ),
      /exact durable authority/u,
    );
    assert.equal(
      await store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
        binding.toolCallId,
        cleanupOwner,
      ),
      "conflict",
      "ordinary effects must refuse cleanup evidence quarantine",
    );
    await assert.rejects(
      wrongTenantStore.commitPreparedApprovalCleanupEffectDone(
        cleanupEffectId,
        cleanupOwner,
        {
          idempotencyKey: cleanupEffectId,
          status: "DONE",
          output: {
            releasedPreparedInvocationId: cleanupPreparedToolCall.callId,
          },
          timestamp: "2026-08-27T00:00:04.000Z",
        },
      ),
      /tenant does not match/u,
    );
    await assert.rejects(
      store.commitPreparedApprovalCleanupEffectDone(
        cleanupEffectId,
        cleanupOwner,
        {
          idempotencyKey: `${cleanupEffectId}:wrong`,
          status: "DONE",
          output: {
            releasedPreparedInvocationId: cleanupPreparedToolCall.callId,
          },
          timestamp: "2026-08-27T00:00:04.000Z",
        },
      ),
      /exact durable authority/u,
    );
    await assert.rejects(
      store.commitPreparedApprovalCleanupEffectDone(
        binding.toolCallId,
        cleanupOwner,
        {
          idempotencyKey: binding.toolCallId,
          status: "DONE",
          output: {
            releasedPreparedInvocationId: binding.toolCallId,
          },
          timestamp: "2026-08-27T00:00:04.000Z",
        },
      ),
      /exact durable authority/u,
    );
    const conflictingPreparedToolCall = await prepareTestToolCall({
      gateway,
      toolName: "code.execute",
      toolInput: { language: "javascript", code: "return 2" },
      runId,
      sessionId,
      callId: `cleanup-conflict-${suffix}`,
    });
    const conflictingEffectId = `${conflictingPreparedToolCall.callId}:release`;
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json,
          idempotency_key, failure_policy, status, created_at, tenant_id,
          tenant_ownership_state)
       VALUES ($1, $2, 3, 'release_prepared_tool_call', $3::jsonb, $4,
               'STOP', 'PENDING', NOW(), $5, 'tenant_bound')`,
      [
        runId,
        sessionId,
        JSON.stringify({
          preparedToolCall: conflictingPreparedToolCall,
          preparedApprovalCleanup: {
            version: "runner_prepared_approval_cleanup_v1",
            organizationId: binding.tenantId,
            threadId: sessionId,
            turnId: `cleanup-conflict-turn-${suffix}`,
            interactionId: `cleanup-conflict-interaction-${suffix}`,
            requestId: `cleanup-conflict-request-${suffix}`,
            failureCode: "EXTERNAL_APPROVAL_EXPIRED",
            failureMessage: "Expired.",
          },
        }),
        conflictingEffectId,
        binding.tenantId,
      ],
    );
    const rawEquivalentOutput: Record<string, unknown> = {
      releasedPreparedInvocationId: "wrong-call",
      apiKey: "pg-api-key-sentinel",
      providerPayload: { token: "pg-provider-token-sentinel" },
      url: "https://pg-private.example.invalid/provider",
      omitted: undefined,
      functionValue: () => "pg-function-secret-sentinel",
      invalidUnicode: "bad\ud800value",
      throwingToJson: {
        toJSON() {
          throw new Error("pg-to-json-secret-sentinel");
        },
      },
    };
    rawEquivalentOutput.self = rawEquivalentOutput;
    await store.saveEffectResult(runId, sessionId, {
      idempotencyKey: conflictingEffectId,
      status: "DONE",
      output: rawEquivalentOutput,
      timestamp: "2026-08-27T00:00:01.000Z",
    });
    assert.equal(
      await store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
        conflictingEffectId,
        cleanupOwner,
      ),
      "conflict",
      "public persistence quarantines malformed cleanup evidence atomically",
    );
    assert.equal(
      (await store.getPersistedEffect(conflictingEffectId))?.status,
      "PENDING",
      "conflicting DONE evidence must become claimable cleanup work",
    );
    const quarantinedConflict = await store.getEffectResult(
      conflictingEffectId,
    );
    assert.equal(quarantinedConflict?.status, "FAILED");
    assert.equal(
      quarantinedConflict?.error?.code,
      "PREPARED_APPROVAL_CLEANUP_DONE_EVIDENCE_INVALID",
    );
    assert.equal(quarantinedConflict?.output, undefined);
    assert.equal(typeof quarantinedConflict?.timestamp, "string");
    assert.equal(
      new Date(quarantinedConflict!.timestamp).toISOString(),
      quarantinedConflict!.timestamp,
      "quarantine replacement uses one trusted canonical occurrence time",
    );
    assert.notEqual(
      quarantinedConflict?.timestamp,
      "2026-08-27T00:00:01.000Z",
      "the untrusted result timestamp must not become the replacement timestamp",
    );
    assert.equal(
      await store.resetPreparedApprovalCleanupEffectExecution(
        conflictingEffectId,
        cleanupOwner,
      ),
      "reset",
    );
    assert.equal(await store.getEffectResult(conflictingEffectId), null);
    assert.equal(
      await store.claimEffectExecution(conflictingEffectId, cleanupOwner),
      "claimed",
    );
    let releaseStarted!: () => void;
    const startedRelease = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let permitRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      permitRelease = resolve;
    });
    let concurrentReleaseCalls = 0;
    const executeRelease = async () => {
      concurrentReleaseCalls += 1;
      releaseStarted();
      await releaseGate;
      return {
        idempotencyKey: conflictingEffectId,
        status: "DONE" as const,
        output: {
          releasedPreparedInvocationId: conflictingPreparedToolCall.callId,
        },
        timestamp: "2026-08-27T00:00:02.000Z",
      };
    };
    const firstCleanupExecution =
      store.executePreparedApprovalCleanupInCriticalSection(
        conflictingEffectId,
        cleanupOwner,
        executeRelease,
      );
    await startedRelease;
    const secondCleanupExecution =
      store.executePreparedApprovalCleanupInCriticalSection(
        conflictingEffectId,
        cleanupOwner,
        executeRelease,
      );
    permitRelease();
    const serializedCleanup = await Promise.all([
      firstCleanupExecution,
      secondCleanupExecution,
    ]);
    assert.deepEqual(
      serializedCleanup.map((outcome) => outcome.status).sort(),
      ["done", "executed"],
    );
    assert.equal(concurrentReleaseCalls, 1);
    assert.equal(
      (await store.getPersistedEffect(conflictingEffectId))?.status,
      "DONE",
    );
    const quarantineEvents = await store.getReplayStream({
      runId,
      eventTypes: [
        "prepared_approval_cleanup.done_evidence_quarantined",
      ],
    });
    const conflictingAudit = quarantineEvents.find((event) => {
      const resultIdentity = event.metadata?.resultIdentity as
        Record<string, unknown> | undefined;
      return resultIdentity?.originalTimestamp ===
        "2026-08-27T00:00:01.000Z";
    });
    const conflictingAuditTimestamp = conflictingAudit?.timestamp as unknown;
    assert.equal(
      conflictingAuditTimestamp instanceof Date
        ? conflictingAuditTimestamp.toISOString()
        : conflictingAuditTimestamp,
      quarantinedConflict?.timestamp,
      "the audit and replacement must share the same trusted occurrence time",
    );
    const conflictingEffect = await store.getPersistedEffect(conflictingEffectId);
    assert.ok(conflictingEffect);
    const expectedRawAudit =
      buildPreparedApprovalCleanupDoneEvidenceQuarantineEvent({
        effect: conflictingEffect,
        invalidResult: {
          idempotencyKey: conflictingEffectId,
          status: "DONE",
          output: rawEquivalentOutput,
          timestamp: "2026-08-27T00:00:01.000Z",
        },
        occurredAt: "2026-08-27T00:00:02.000Z",
      });
    assert.deepEqual(
      conflictingAudit?.metadata?.evidence,
      expectedRawAudit.metadata?.evidence,
      "the persistence boundary must audit the original value before JSONB projection",
    );
    const conflictingResultIdentity = conflictingAudit?.metadata
      ?.resultIdentity as Record<string, unknown>;
    assert.equal(conflictingResultIdentity.status, "DONE");
    assert.equal(
      (conflictingResultIdentity.idempotencyKey as Record<string, unknown>)
        .canonicalHash,
      hashCanonical({ value: conflictingEffectId }),
    );
    const serializedConflictAudit = JSON.stringify(conflictingAudit);
    for (const sentinel of [
      conflictingEffectId,
      "wrong-call",
      "pg-api-key-sentinel",
      "pg-provider-token-sentinel",
      "pg-private.example.invalid",
      "pg-function-secret-sentinel",
    ]) {
      assert.equal(serializedConflictAudit.includes(sentinel), false, sentinel);
    }
    assert.equal(
      conflictingAudit?.metadata?.validationReasonCode,
      "PREPARED_APPROVAL_CLEANUP_DONE_EVIDENCE_INVALID",
    );
    assert.match(
      String((conflictingAudit?.metadata?.evidence as Record<string, unknown>)
        .canonicalHash),
      /^sha256:[0-9a-f]{64}$/u,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(conflictingAudit?.metadata)) <=
        PREPARED_APPROVAL_CLEANUP_QUARANTINE_AUDIT_MAX_METADATA_BYTES,
    );
    assert.equal(
      (await store.executePreparedApprovalCleanupInCriticalSection(
        conflictingEffectId,
        cleanupOwner,
        executeRelease,
      )).status,
      "done",
    );
    assert.equal(
      concurrentReleaseCalls,
      1,
      "exact DONE recheck must skip the cleanup handler",
    );

    const longPreparedToolCall = await prepareTestToolCall({
      gateway,
      toolName: "code.execute",
      toolInput: { language: "javascript", code: "return 4" },
      runId,
      sessionId,
      callId: `cleanup-long-${"valid-😀".repeat(100)}-${suffix}`,
    });
    const longEffectId = `${longPreparedToolCall.callId}:release`;
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json,
          idempotency_key, failure_policy, status, created_at, tenant_id,
          tenant_ownership_state)
       VALUES ($1, $2, 30, 'release_prepared_tool_call', $3::jsonb, $4,
               'STOP', 'PENDING', NOW(), $5, 'tenant_bound')`,
      [
        runId,
        sessionId,
        JSON.stringify({
          preparedToolCall: longPreparedToolCall,
          preparedApprovalCleanup: {
            version: "runner_prepared_approval_cleanup_v1",
            organizationId: binding.tenantId,
            threadId: sessionId,
            turnId: `cleanup-long-turn-${suffix}`,
            interactionId: `cleanup-long-interaction-${suffix}`,
            requestId: `cleanup-long-request-${suffix}`,
            failureCode: "EXTERNAL_APPROVAL_EXPIRED",
            failureMessage: "Expired.",
          },
        }),
        longEffectId,
        binding.tenantId,
      ],
    );
    const longResult = {
      idempotencyKey: longEffectId,
      status: "DONE" as const,
      output: {
        releasedPreparedInvocationId: longPreparedToolCall.callId,
      },
      timestamp: "2026-08-27T00:00:06.000Z",
    };
    const expectedLongResult = structuredClone(longResult);
    const longResultSave = store.saveEffectResult(runId, sessionId, longResult);
    longResult.output.releasedPreparedInvocationId = "post-save-mutation";
    await longResultSave;
    assert.equal(
      await store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
        longEffectId,
        cleanupOwner,
      ),
      "done",
    );
    assert.deepEqual(
      await store.getEffectResult(longEffectId),
      expectedLongResult,
      "the synchronous cleanup snapshot must isolate post-save mutation",
    );

    const upgradePreparedToolCall = await prepareTestToolCall({
      gateway,
      toolName: "code.execute",
      toolInput: { language: "javascript", code: "return 5" },
      runId,
      sessionId,
      callId: `cleanup-upgrade-${suffix}`,
    });
    const upgradeEffectId = `${upgradePreparedToolCall.callId}:release`;
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json,
          idempotency_key, failure_policy, status, created_at, tenant_id,
          tenant_ownership_state)
       VALUES ($1, $2, 31, 'release_prepared_tool_call', $3::jsonb, $4,
               'STOP', 'PENDING', NOW(), $5, 'tenant_bound')`,
      [
        runId,
        sessionId,
        JSON.stringify({
          preparedToolCall: upgradePreparedToolCall,
          preparedApprovalCleanup: {
            version: "runner_prepared_approval_cleanup_v1",
            organizationId: binding.tenantId,
            threadId: sessionId,
            turnId: `cleanup-upgrade-turn-${suffix}`,
            interactionId: `cleanup-upgrade-interaction-${suffix}`,
            requestId: `cleanup-upgrade-request-${suffix}`,
            failureCode: "EXTERNAL_APPROVAL_EXPIRED",
            failureMessage: "Expired.",
          },
        }),
        upgradeEffectId,
        binding.tenantId,
      ],
    );
    let upgradeGetterReads = 0;
    const invalidUpgradeOutput: Record<string, unknown> = {};
    Object.defineProperty(invalidUpgradeOutput, "releasedPreparedInvocationId", {
      enumerable: true,
      get() {
        upgradeGetterReads += 1;
        return upgradeGetterReads === 1
          ? upgradePreparedToolCall.callId
          : "stateful-getter-drift";
      },
    });
    await store.saveEffectResult(runId, sessionId, {
      idempotencyKey: upgradeEffectId,
      status: "DONE",
      output: invalidUpgradeOutput,
      timestamp: "2026-08-27T00:00:07.000Z",
    });
    assert.equal((await store.getEffectResult(upgradeEffectId))?.status, "FAILED");
    assert.ok(upgradeGetterReads <= 1);
    assert.equal(
      (await store.getPersistedEffect(upgradeEffectId))?.status,
      "PENDING",
    );
    assert.equal(
      await store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
        upgradeEffectId,
        cleanupOwner,
      ),
      "conflict",
      "lossy JSON serialization must never upgrade malformed exact-looking output",
    );

    const timestampPreparedToolCall = await prepareTestToolCall({
      gateway,
      toolName: "code.execute",
      toolInput: { language: "javascript", code: "return 5.5" },
      runId,
      sessionId,
      callId: `cleanup-timestamp-${suffix}`,
    });
    const timestampEffectId = `${timestampPreparedToolCall.callId}:release`;
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json,
          idempotency_key, failure_policy, status, created_at, tenant_id,
          tenant_ownership_state)
       VALUES ($1, $2, 33, 'release_prepared_tool_call', $3::jsonb, $4,
               'STOP', 'PENDING', NOW(), $5, 'tenant_bound')`,
      [
        runId,
        sessionId,
        JSON.stringify({
          preparedToolCall: timestampPreparedToolCall,
          preparedApprovalCleanup: {
            version: "runner_prepared_approval_cleanup_v1",
            organizationId: binding.tenantId,
            threadId: sessionId,
            turnId: `cleanup-timestamp-turn-${suffix}`,
            interactionId: `cleanup-timestamp-interaction-${suffix}`,
            requestId: `cleanup-timestamp-request-${suffix}`,
            failureCode: "EXTERNAL_APPROVAL_EXPIRED",
            failureMessage: "Expired.",
          },
        }),
        timestampEffectId,
        binding.tenantId,
      ],
    );
    await store.saveEffectResult(runId, sessionId, {
      idempotencyKey: timestampEffectId,
      status: "DONE",
      output: {
        releasedPreparedInvocationId: timestampPreparedToolCall.callId,
      },
      timestamp: (() => "pg-hostile-timestamp-secret") as never,
    });
    const quarantinedTimestamp = await store.getEffectResult(timestampEffectId);
    assert.equal(quarantinedTimestamp?.status, "FAILED");
    const timestampEvents = await store.getReplayStream({
      runId,
      eventTypes: ["prepared_approval_cleanup.done_evidence_quarantined"],
    });
    const timestampAudit = timestampEvents.find((event) => {
      const effectIdentity = event.metadata?.effectIdentity as
        Record<string, unknown> | undefined;
      return (
        (effectIdentity?.idempotencyKey as Record<string, unknown> | undefined)
          ?.canonicalHash === hashCanonical({ value: timestampEffectId })
      );
    });
    assert.ok(timestampAudit);
    const timestampAuditOccurredAt = timestampAudit.timestamp as unknown;
    assert.equal(
      timestampAuditOccurredAt instanceof Date
        ? timestampAuditOccurredAt.toISOString()
        : timestampAuditOccurredAt,
      quarantinedTimestamp?.timestamp,
    );
    assert.equal(
      JSON.stringify(timestampAudit).includes("pg-hostile-timestamp-secret"),
      false,
    );

    const corruptEffectId = `cleanup-corrupt-${suffix}:release`;
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json,
          idempotency_key, failure_policy, status, created_at, tenant_id,
          tenant_ownership_state)
       VALUES ($1, $2, 34, 'release_prepared_tool_call', $3::jsonb, $4,
               'STOP', 'PENDING', NOW(), $5, 'tenant_bound')`,
      [
        runId,
        sessionId,
        JSON.stringify({
          preparedToolCall: { version: "v1", callId: `cleanup-corrupt-${suffix}` },
          preparedApprovalCleanup: {
            version: "runner_prepared_approval_cleanup_v1",
            organizationId: binding.tenantId,
            threadId: sessionId,
            turnId: `cleanup-corrupt-turn-${suffix}`,
            interactionId: `cleanup-corrupt-interaction-${suffix}`,
            requestId: `cleanup-corrupt-request-${suffix}`,
            failureCode: "EXTERNAL_APPROVAL_EXPIRED",
            failureMessage: "Expired.",
          },
        }),
        corruptEffectId,
        binding.tenantId,
      ],
    );
    const eventsBeforeCorruptSave = (await store.getReplayStream({
      runId,
      eventTypes: ["prepared_approval_cleanup.done_evidence_quarantined"],
    })).length;
    await assert.rejects(
      store.saveEffectResult(runId, sessionId, {
        idempotencyKey: corruptEffectId,
        status: "DONE",
        output: { releasedPreparedInvocationId: `cleanup-corrupt-${suffix}` },
        timestamp: "2026-08-27T00:00:09.000Z",
      }),
      /exact durable prepared tool call/u,
    );
    assert.equal(await store.getEffectResult(corruptEffectId), null);
    assert.equal((await store.getReplayStream({
      runId,
      eventTypes: ["prepared_approval_cleanup.done_evidence_quarantined"],
    })).length, eventsBeforeCorruptSave);

    await assert.rejects(
      prepareTestToolCall({
        gateway,
        toolName: "code.execute",
        toolInput: { language: "javascript", code: "return 7" },
        runId,
        sessionId,
        callId: `cleanup-invalid-\ud800-${suffix}`,
      }),
      /valid UTF-16/u,
    );

    const legacyPreparedToolCall = await prepareTestToolCall({
      gateway,
      toolName: "code.execute",
      toolInput: { language: "javascript", code: "return 6" },
      runId,
      sessionId,
      callId: `cleanup-legacy-${suffix}`,
    });
    const legacyEffectId = `${legacyPreparedToolCall.callId}:release`;
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json,
          idempotency_key, failure_policy, status, created_at, tenant_id,
          tenant_ownership_state)
       VALUES ($1, $2, 32, 'release_prepared_tool_call', $3::jsonb, $4,
               'STOP', 'PENDING', NOW(), $5, 'tenant_bound')`,
      [
        runId,
        sessionId,
        JSON.stringify({
          preparedToolCall: legacyPreparedToolCall,
          preparedApprovalCleanup: {
            version: "runner_prepared_approval_cleanup_v1",
            organizationId: binding.tenantId,
            threadId: sessionId,
            turnId: `cleanup-legacy-turn-${suffix}`,
            interactionId: `cleanup-legacy-interaction-${suffix}`,
            requestId: `cleanup-legacy-request-${suffix}`,
            failureCode: "EXTERNAL_APPROVAL_EXPIRED",
            failureMessage: "Expired.",
          },
        }),
        legacyEffectId,
        binding.tenantId,
      ],
    );
    await pool.query(
      `INSERT INTO effect_results
         (run_id, session_id, idempotency_key, status, output_json,
          error_json, created_at)
       VALUES ($1, $2, $3, 'DONE', $4::jsonb, NULL,
               '2026-08-27T00:00:08.000Z'::timestamptz)`,
      [
        runId,
        sessionId,
        legacyEffectId,
        JSON.stringify({
          releasedPreparedInvocationId: "wrong-legacy-call",
          $kestrelCleanupEvidence: "object_entries_and_keys_truncated",
          "$kestrelCleanupKey:v1:forged": "forged-prefix-value",
        }),
      ],
    );
    assert.equal(
      await store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
        legacyEffectId,
        cleanupOwner,
      ),
      "quarantined",
    );
    const legacyEvents = await store.getReplayStream({
      runId,
      eventTypes: ["prepared_approval_cleanup.done_evidence_quarantined"],
    });
    const legacyAudit = legacyEvents.find((event) =>
      (event.metadata?.resultIdentity as Record<string, unknown> | undefined)
        ?.originalTimestamp === "2026-08-27T00:00:08.000Z"
    );
    const legacyEvidence = legacyAudit?.metadata?.evidence as
      Record<string, unknown>;
    assert.equal(legacyEvidence.sourceBytesTruncated, false);
    assert.equal(legacyEvidence.traversalTruncated, false);
    assert.equal(
      (legacyEvidence.outputShape as Record<string, unknown>)
        .topLevelEntriesTruncated,
      false,
    );
    let ordinaryCriticalSectionCalls = 0;
    assert.deepEqual(
      await store.executePreparedApprovalCleanupInCriticalSection(
        binding.toolCallId,
        { runId, sessionId },
        async () => {
          ordinaryCriticalSectionCalls += 1;
          throw new Error("ordinary effect must not enter cleanup execution");
        },
      ),
      { status: "conflict" },
    );
    assert.equal(ordinaryCriticalSectionCalls, 0);

    const crashPreparedToolCall = await prepareTestToolCall({
      gateway,
      toolName: "code.execute",
      toolInput: { language: "javascript", code: "return 3" },
      runId,
      sessionId,
      callId: `cleanup-crash-${suffix}`,
    });
    const crashEffectId = `${crashPreparedToolCall.callId}:release`;
    await pool.query(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, payload_json,
          idempotency_key, failure_policy, status, created_at, tenant_id,
          tenant_ownership_state)
       VALUES ($1, $2, 4, 'release_prepared_tool_call', $3::jsonb, $4,
               'STOP', 'CLAIMED', NOW(), $5, 'tenant_bound')`,
      [
        runId,
        sessionId,
        JSON.stringify({
          preparedToolCall: crashPreparedToolCall,
          preparedApprovalCleanup: {
            version: "runner_prepared_approval_cleanup_v1",
            organizationId: binding.tenantId,
            threadId: sessionId,
            turnId: `cleanup-crash-turn-${suffix}`,
            interactionId: `cleanup-crash-interaction-${suffix}`,
            requestId: `cleanup-crash-request-${suffix}`,
            failureCode: "EXTERNAL_APPROVAL_EXPIRED",
            failureMessage: "Expired.",
          },
        }),
        crashEffectId,
        binding.tenantId,
      ],
    );
    await assert.rejects(
      store.executePreparedApprovalCleanupInCriticalSection(
        crashEffectId,
        cleanupOwner,
        async () => {
          throw new Error("injected cleanup handler crash");
        },
      ),
      /injected cleanup handler crash/u,
    );
    assert.equal(
      (await store.getPersistedEffect(crashEffectId))?.status,
      "CLAIMED",
      "a thrown handler must roll back while releasing the transaction lock",
    );
    assert.equal(await store.getEffectResult(crashEffectId), null);
    assert.equal(
      await store.resetPreparedApprovalCleanupEffectExecution(
        crashEffectId,
        cleanupOwner,
      ),
      "reset",
    );
    assert.equal(
      await store.claimEffectExecution(crashEffectId, cleanupOwner),
      "claimed",
    );
    const crashRetry =
      await store.executePreparedApprovalCleanupInCriticalSection(
        crashEffectId,
        cleanupOwner,
        async () => ({
          idempotencyKey: crashEffectId,
          status: "DONE",
          output: {
            releasedPreparedInvocationId: crashPreparedToolCall.callId,
          },
          timestamp: "2026-08-27T00:00:03.000Z",
        }),
      );
    assert.equal(crashRetry.status, "executed");
    assert.equal((await store.getPersistedEffect(crashEffectId))?.status, "DONE");
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
         (run_id, session_id, step_index, effect_type, payload_json, idempotency_key, failure_policy, status, created_at, tenant_id, tenant_ownership_state)
       VALUES ($1, $2, 1, 'execute_tool_call', $3::jsonb, $4, 'STOP', 'PENDING', NOW(), $5, 'tenant_bound')`,
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
         (run_id, session_id, step_index, effect_type, payload_json, idempotency_key, failure_policy, status, created_at, tenant_id, tenant_ownership_state)
       VALUES ($1, $2, 1, 'execute_tool_call', $3::jsonb, $4, 'STOP', 'PENDING', NOW(), $5, 'tenant_bound')`,
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
