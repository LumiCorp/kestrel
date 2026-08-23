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
import { PgSqlExecutor } from "../src/store/PgSqlExecutor.js";
import { PostgresSessionStore } from "../src/store/PostgresSessionStore.js";

const databaseUrl = process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL?.trim();

test("PostgreSQL capability lease ledger serializes CAS transitions and preserves immutable evidence", async () => {
  assert.ok(databaseUrl, "KESTREL_PRODUCT_RUNNER_DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const store = new PostgresSessionStore(new PgSqlExecutor(pool));
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
    const child = (id: string): SandboxCapabilityChildReservationV1 => ({ version: 1, reservationId: `${id}-${suffix}`, sequence: 1, status: "reserved", decision: { version: 1, decisionId: `decision-${id}-${suffix}`, parentLeaseId: leaseId, parentBindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding), childSessionId: `child-session-${id}`, childRunId: `child-run-${id}`, childToolCallId: `child-call-${id}`, policyRevision: `policy-${id}`, approval: { approvalId: `approval-${id}`, authorityRevision: `authority-${id}` }, requestLimit: 1, responseByteLimit: 4096, decidedAt: "2026-08-23T12:00:03.000Z" }, requestsCommitted: 0, responseBytesCommitted: 0, occurredAt: "2026-08-23T12:00:03.000Z" });
    const childContention = await Promise.allSettled([store.reserveSandboxCapabilityChild({ expectedParentSequence: 3, reservation: child("a") }), store.reserveSandboxCapabilityChild({ expectedParentSequence: 3, reservation: child("b") })]);
    assert.equal(childContention.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(childContention.filter((item) => item.status === "rejected").length, 1);
    const reserved = (await store.listSandboxCapabilityChildReservations(leaseId))[0]!;
    await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 3, record: { ...record(4, "revoked"), terminalOutcome: "revoked" } });
    assert.equal((await store.getSandboxCapabilityChildReservation(reserved.reservationId))?.status, "revoked");
  } finally {
    await pool.query("DELETE FROM runs WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    await pool.end();
  }
});
