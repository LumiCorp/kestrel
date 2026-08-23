import assert from "node:assert/strict";
import test from "node:test";

import {
  fingerprintSandboxCapabilityLeaseBindingV1,
  parseSandboxCapabilityChildReservationV1,
  parseSandboxCapabilityLeaseTransitionRecordV1,
  TAVILY_SEARCH_CAPABILITY_ID,
  TAVILY_SEARCH_OPERATION,
  TAVILY_SEARCH_RESOURCE,
  type SandboxCapabilityLeaseBindingV1,
  type SandboxCapabilityChildReservationV1,
  type SandboxCapabilityLeaseTransitionRecordV1,
} from "../../src/kestrel/contracts/sandbox-capability.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";

const hash = "a".repeat(64);
const binding: SandboxCapabilityLeaseBindingV1 = {
  version: 1, tenantId: "tenant-a", environmentId: "env-a", sessionId: "session-a", runId: "run-a", toolCallId: "call-a",
  profileFingerprint: hash, capabilityCatalogFingerprint: "b".repeat(64), executionBoundaryRevision: "boundary-r1",
  capabilityId: TAVILY_SEARCH_CAPABILITY_ID, operation: TAVILY_SEARCH_OPERATION, resource: TAVILY_SEARCH_RESOURCE,
  audience: { tenantId: "tenant-a", environmentId: "env-a" }, brokerAuthority: { authorityId: "broker-a", revision: "r1" },
  credentialReference: { credentialId: "tool.tavily.default", revision: "credential-r1" }, policyRevision: "policy-r1",
  approval: { approvalId: "approval-a", authorityRevision: "approval-r1" },
  parentAuthorization: { leaseId: "parent-a", bindingDigest: "c".repeat(64), authorizationDecisionId: "decision-a", reservationId: "reservation-a", requestLimit: 1, responseByteLimit: 4096 },
};

function transition(sequence: number, state: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 {
  return {
    version: 1, leaseId: "lease-a", sequence, transition: state, binding,
    bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding),
    usage: { requestLimit: 1, requestsConsumed: state === "consumed" ? 1 : 0, responseByteLimit: 4096, responseBytesConsumed: 0, exactProviderUsage: null },
    expiresAt: "2026-08-23T12:05:00.000Z", occurredAt: `2026-08-23T12:00:0${sequence}.000Z`,
    ...(state === "issued" ? { issuedAt: "2026-08-23T12:00:02.000Z" } : {}),
  };
}

test("lease parser rejects secrets, inconsistent audience, invented provider usage, and over-ceiling usage", () => {
  assert.throws(() => parseSandboxCapabilityLeaseTransitionRecordV1({ ...transition(1, "requested"), leaseToken: "secret" }), /unknown field/u);
  assert.throws(() => parseSandboxCapabilityLeaseTransitionRecordV1({ ...transition(1, "requested"), binding: { ...binding, secret: "raw-key" } }), /unknown field/u);
  assert.throws(() => parseSandboxCapabilityLeaseTransitionRecordV1({ ...transition(1, "requested"), binding: { ...binding, audience: { tenantId: "other", environmentId: "env-a" } } }), /audience is inconsistent/u);
  assert.throws(() => parseSandboxCapabilityLeaseTransitionRecordV1({ ...transition(1, "requested"), usage: { ...transition(1, "requested").usage, exactProviderUsage: 1.5 } }), /outside its allowed range/u);
  assert.throws(() => parseSandboxCapabilityLeaseTransitionRecordV1({ ...transition(1, "requested"), usage: { ...transition(1, "requested").usage, requestsConsumed: 2 } }), /exceeds its ceiling/u);
});

test("in-memory child reservations serialize sibling ceilings and cascade parent revocation", async () => {
  const store = new InMemorySessionStore();
  const parentBinding = { ...binding, parentAuthorization: undefined };
  const parentDigest = fingerprintSandboxCapabilityLeaseBindingV1(parentBinding);
  const parentRecord = (sequence: number, state: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 => ({ ...transition(sequence, state), leaseId: "parent-lease", binding: parentBinding, bindingDigest: parentDigest, usage: { requestLimit: 1, requestsConsumed: 0, responseByteLimit: 4096, responseBytesConsumed: 0, exactProviderUsage: null } });
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: parentRecord(1, "requested") });
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: parentRecord(2, "issued") });
  const reservation = (id: string, callId: string): SandboxCapabilityChildReservationV1 => ({ version: 1, reservationId: id, sequence: 1, status: "reserved", decision: { version: 1, decisionId: `decision-${id}`, parentLeaseId: "parent-lease", parentBindingDigest: parentDigest, childSessionId: `session-${id}`, childRunId: `run-${id}`, childToolCallId: callId, policyRevision: `policy-${id}`, approval: { approvalId: `approval-${id}`, authorityRevision: `authority-${id}` }, requestLimit: 1, responseByteLimit: 4096, decidedAt: "2026-08-23T12:00:02.000Z" }, requestsCommitted: 0, responseBytesCommitted: 0, occurredAt: "2026-08-23T12:00:02.000Z" });
  assert.throws(() => parseSandboxCapabilityChildReservationV1({ ...reservation("no-approval", "call-no-approval"), decision: { ...reservation("no-approval", "call-no-approval").decision, approval: undefined } }), /must be an object/u);
  await assert.rejects(store.reserveSandboxCapabilityChild({ expectedParentSequence: 2, reservation: { ...reservation("stale", "call-stale"), decision: { ...reservation("stale", "call-stale").decision, parentBindingDigest: "d".repeat(64) } } }), /unavailable or stale/u);
  assert.throws(() => parseSandboxCapabilityLeaseTransitionRecordV1({ ...transition(1, "requested"), binding: { ...binding, parentAuthorization: { ...binding.parentAuthorization, authorizationDecisionId: "" } } }), /authorizationDecisionId/u);
  const siblings = await Promise.allSettled([store.reserveSandboxCapabilityChild({ expectedParentSequence: 2, reservation: reservation("a", "call-a") }), store.reserveSandboxCapabilityChild({ expectedParentSequence: 2, reservation: reservation("b", "call-b") })]);
  assert.equal(siblings.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(siblings.filter((item) => item.status === "rejected").length, 1);
  const reserved = (await store.listSandboxCapabilityChildReservations("parent-lease"))[0]!;
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 2, record: { ...parentRecord(3, "revoked"), terminalOutcome: "revoked" } });
  assert.equal((await store.getSandboxCapabilityChildReservation(reserved.reservationId))?.status, "revoked");
  await assert.rejects(store.settleSandboxCapabilityChild({ reservationId: reserved.reservationId, expectedSequence: 1, status: "committed", requestsCommitted: 1, responseBytesCommitted: 100, occurredAt: "2026-08-23T12:00:04.000Z" }), /sequence conflict/u);
});

test("child settlement propagates committed usage and releases unused reservations", async () => {
  const store = new InMemorySessionStore();
  const parentBinding = { ...binding, parentAuthorization: undefined };
  const parentDigest = fingerprintSandboxCapabilityLeaseBindingV1(parentBinding);
  const parentRecord = (sequence: number, state: SandboxCapabilityLeaseTransitionRecordV1["transition"]): SandboxCapabilityLeaseTransitionRecordV1 => ({ ...transition(sequence, state), leaseId: "settlement-parent", binding: parentBinding, bindingDigest: parentDigest, usage: { requestLimit: 1, requestsConsumed: 0, responseByteLimit: 4096, responseBytesConsumed: 0, exactProviderUsage: null } });
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: parentRecord(1, "requested") });
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: parentRecord(2, "issued") });
  const reservation = (id: string): SandboxCapabilityChildReservationV1 => ({ version: 1, reservationId: id, sequence: 1, status: "reserved", decision: { version: 1, decisionId: `decision-${id}`, parentLeaseId: "settlement-parent", parentBindingDigest: parentDigest, childSessionId: `session-${id}`, childRunId: `run-${id}`, childToolCallId: `call-${id}`, policyRevision: `policy-${id}`, approval: { approvalId: `approval-${id}`, authorityRevision: `authority-${id}` }, requestLimit: 1, responseByteLimit: 4096, decidedAt: "2026-08-23T12:00:02.000Z" }, requestsCommitted: 0, responseBytesCommitted: 0, occurredAt: "2026-08-23T12:00:02.000Z" });
  await store.reserveSandboxCapabilityChild({ expectedParentSequence: 2, reservation: reservation("released") });
  await store.settleSandboxCapabilityChild({ reservationId: "released", expectedSequence: 1, status: "released", requestsCommitted: 0, responseBytesCommitted: 0, occurredAt: "2026-08-23T12:00:03.000Z" });
  await store.reserveSandboxCapabilityChild({ expectedParentSequence: 2, reservation: reservation("committed") });
  await store.settleSandboxCapabilityChild({ reservationId: "committed", expectedSequence: 1, status: "committed", requestsCommitted: 1, responseBytesCommitted: 100, occurredAt: "2026-08-23T12:00:04.000Z" });
  await assert.rejects(store.reserveSandboxCapabilityChild({ expectedParentSequence: 2, reservation: reservation("over") }), /parent ceiling is exhausted/u);
});

test("in-memory lease store appends an immutable CAS ledger and exposes recoverable projections", async () => {
  const store = new InMemorySessionStore();
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 0, record: transition(1, "requested") });
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: transition(2, "issued") });
  await assert.rejects(store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 1, record: transition(3, "consumed") }), /sequence conflict/u);
  await assert.rejects(store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 2, record: { ...transition(3, "consumed"), binding: { ...binding, runId: "run-other" } } }), /binding digest does not match/u);
  assert.equal((await store.getSandboxCapabilityLease("lease-a"))?.transition, "issued");
  assert.deepEqual((await store.listSandboxCapabilityLeaseTransitions("lease-a")).map((item) => item.transition), ["requested", "issued"]);
  assert.deepEqual(store.getRunEvents().filter((item) => item.type.startsWith("sandbox_capability.")).map((item) => [item.type, (item.metadata?.record as { leaseId?: string }).leaseId]), [["sandbox_capability.requested", "lease-a"], ["sandbox_capability.issued", "lease-a"]]);
  assert.deepEqual((await store.listRecoverableSandboxCapabilityLeases({ before: "2026-08-23T12:01:00.000Z" })).map((item) => item.leaseId), ["lease-a"]);
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 2, record: { ...transition(3, "cancelled"), terminalOutcome: "cancelled" } });
  await store.appendSandboxCapabilityLeaseTransition({ expectedSequence: 3, record: { ...transition(4, "cleaned"), terminalOutcome: "cancelled", cleanedAt: "2026-08-23T12:00:04.000Z" } });
  assert.equal((await store.getSandboxCapabilityLease("lease-a"))?.terminalOutcome, "cancelled");
  assert.equal((await store.listRecoverableSandboxCapabilityLeases({ before: "2026-08-23T12:01:00.000Z" })).length, 0);
});
