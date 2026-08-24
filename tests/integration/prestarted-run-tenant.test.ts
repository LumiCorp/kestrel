import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ClaimConversationTurnExecutionInput } from "../../src/kestrel/contracts/store.js";
import { createSqlExecutorFromEnv } from "../../src/store/createSessionStore.js";
import { PostgresSessionStore } from "../../src/store/PostgresSessionStore.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import type { PersistedEffect } from "../../src/kestrel/contracts/store.js";
import { createTestToolGateway, prepareTestToolCall } from "../helpers/createTestToolGateway.js";

const sessionId = "session-tenant-claim";
const threadId = "thread-tenant-claim";
const turnId = "turn-tenant-claim";
const runId = "run-tenant-claim";
const toolCallId = "call-tenant-claim";
const tenantId = "tenant-authoritative";

function claimInput(): ClaimConversationTurnExecutionInput {
  return {
    turnId,
    threadId,
    sessionId,
    turnRequestIdentity: "request-tenant-claim",
    submissionIdentity: "submission-tenant-claim",
    submissionKind: "initial",
    proposedRunId: runId,
    eventType: "user.message",
    startedAt: "2026-08-23T12:00:00.000Z",
    segment: {
      segmentId: "segment-tenant-claim",
      turnId,
      threadId,
      sessionId,
      runId,
      kind: "submission",
      eventType: "user.message",
      messageHash: "message-hash",
      createdAt: "2026-08-23T12:00:00.000Z",
      metadata: { submissionIdentity: "submission-tenant-claim" },
    },
  };
}

test("PGlite prestarted runs and ordinary code.execute effects retain store tenant authority", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-prestarted-tenant-"));
  const handle = createSqlExecutorFromEnv({ driver: "sqlite", sqlitePath: path.join(root, "runtime") });
  t.after(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });
  await handle.ready();
  const store = new PostgresSessionStore(handle.executor, { enforceSchemaV3: true, tenantId });
  await store.ensureSession(sessionId, "agent.loop");
  await store.upsertThread({
    threadId,
    sessionId,
    title: "Tenant claim",
    status: "IDLE",
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
  });
  assert.deepEqual(await store.claimConversationTurnExecution(claimInput()), { kind: "claimed", runId });
  const event = { id: "event-tenant-claim", type: "user.message", sessionId, payload: {} };
  await store.validatePrestartedRun(runId, event);

  const gateway = createTestToolGateway({ "code.execute": async () => ({ status: "ok" }) });
  const preparedToolCall = await prepareTestToolCall({
    gateway,
    toolName: "code.execute",
    toolInput: { language: "javascript", code: "console.log('ok')" },
    runId,
    sessionId,
    callId: toolCallId,
  });
  await store.commitStep({
    runId,
    event,
    sessionId,
    expectedVersion: 0,
    stepAgent: "agent.loop",
    nextStepAgent: "agent.loop",
    statePatch: {},
    effects: [{
      type: "execute_tool_call",
      payload: { preparedToolCall },
      idempotencyKey: toolCallId,
      failurePolicy: "STOP",
    }],
    emitEvents: [],
    stepIndex: 0,
  });

  assert.deepEqual((await handle.executor.query<{ tenant_id: string | null }>(
    "SELECT tenant_id FROM runs WHERE run_id = $1",
    [runId],
  )).rows, [{ tenant_id: tenantId }]);
  assert.deepEqual((await handle.executor.query<{ tenant_id: string | null }>(
    "SELECT tenant_id FROM effects WHERE idempotency_key = $1",
    [toolCallId],
  )).rows, [{ tenant_id: tenantId }]);
  assert.deepEqual(await store.claimExactEffectCancellation({
    sessionId, runId, idempotencyKey: toolCallId, tenantId: "tenant-wrong",
  }), { status: "not_found" });
  assert.deepEqual(await store.claimExactEffectCancellation({
    sessionId, runId, idempotencyKey: toolCallId, tenantId,
  }), { status: "cancelled" });

  await handle.executor.query("UPDATE runs SET tenant_id = $2 WHERE run_id = $1", [runId, "tenant-wrong"]);
  await assert.rejects(store.validatePrestartedRun(runId, event), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "PRESTARTED_RUN_INVALID");
  const legacyCallId = `${toolCallId}-legacy`;
  const legacyPrepared = await prepareTestToolCall({
    gateway, toolName: "code.execute",
    toolInput: { language: "javascript", code: "console.log('legacy')" },
    runId, sessionId, callId: legacyCallId,
  });
  await handle.executor.query(
    `INSERT INTO effects
       (run_id, session_id, step_index, effect_type, payload_json, idempotency_key, failure_policy, status, tenant_id)
     VALUES ($1, $2, 1, 'execute_tool_call', $3::jsonb, $4, 'STOP', 'PENDING', NULL)`,
    [runId, sessionId, JSON.stringify({ preparedToolCall: legacyPrepared }), legacyCallId],
  );
  await handle.executor.query("UPDATE runs SET tenant_id = NULL WHERE run_id = $1", [runId]);
  await store.validatePrestartedRun(runId, event);
  assert.equal((await handle.executor.query<{ tenant_id: string | null }>(
    "SELECT tenant_id FROM runs WHERE run_id = $1",
    [runId],
  )).rows[0]?.tenant_id, tenantId);
  assert.deepEqual((await handle.executor.query<{ tenant_id: string | null; status: string }>(
    "SELECT tenant_id, status FROM effects WHERE idempotency_key = $1",
    [legacyCallId],
  )).rows, [{ tenant_id: tenantId, status: "PENDING" }]);
});

test("InMemory prestarted runs bind, reject, and reconcile store-owned tenant authority", async () => {
  const store = new InMemorySessionStore({ tenantId });
  await store.ensureSession(sessionId, "agent.loop");
  await store.upsertThread({
    threadId, sessionId, title: "Tenant claim", status: "IDLE",
    createdAt: "2026-08-23T12:00:00.000Z", updatedAt: "2026-08-23T12:00:00.000Z",
  });
  assert.deepEqual(await store.claimConversationTurnExecution(claimInput()), { kind: "claimed", runId });
  const event = { id: "event-memory-tenant", type: "user.message", sessionId, payload: { actor: { tenantId: "spoofed" } } };
  const internals = store as unknown as {
    runs: Map<string, { tenantId: string | undefined }>;
    effects: Array<PersistedEffect & { tenantId: string | undefined }>;
  };
  assert.equal(internals.runs.get(runId)?.tenantId, tenantId);

  const gateway = createTestToolGateway({ "code.execute": async () => ({ status: "ok" }) });
  const preparedToolCall = await prepareTestToolCall({
    gateway, toolName: "code.execute",
    toolInput: { language: "javascript", code: "console.log('ok')" },
    runId, sessionId, callId: toolCallId,
  });
  await store.commitStep({
    runId, event, sessionId, expectedVersion: 0, stepAgent: "agent.loop", nextStepAgent: "agent.loop",
    statePatch: {}, effects: [{ type: "execute_tool_call", payload: { preparedToolCall }, idempotencyKey: toolCallId, failurePolicy: "STOP" }],
    emitEvents: [], stepIndex: 0,
  });
  assert.equal(internals.effects[0]?.tenantId, tenantId);

  internals.runs.get(runId)!.tenantId = "tenant-wrong";
  await assert.rejects(store.validatePrestartedRun(runId, event), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "PRESTARTED_RUN_INVALID");
  internals.runs.get(runId)!.tenantId = undefined;
  internals.effects[0]!.tenantId = undefined;
  await store.validatePrestartedRun(runId, event);
  assert.equal(internals.runs.get(runId)?.tenantId, tenantId);
  assert.equal(internals.effects[0]?.tenantId, tenantId);
});
