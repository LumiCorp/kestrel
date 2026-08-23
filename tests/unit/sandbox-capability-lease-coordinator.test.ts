import assert from "node:assert/strict";
import test from "node:test";

import {
  SandboxCapabilityLeaseCoordinator,
  digestSandboxCapabilityResult,
} from "../../src/code/SandboxCapabilityLeaseCoordinator.js";
import type {
  SandboxCapabilityChildReservationV1,
  SandboxCapabilityLeaseBindingV1,
  SandboxCapabilityLeaseTransitionRecordV1,
} from "../../src/kestrel/contracts/sandbox-capability.js";
import type { SandboxCapabilityLeaseStore } from "../../src/kestrel/contracts/store.js";

const hash = "a".repeat(64);
const binding: SandboxCapabilityLeaseBindingV1 = {
  version: 1,
  tenantId: "tenant-a",
  environmentId: "env-a",
  sessionId: "session-a",
  runId: "run-a",
  toolCallId: "tool-a",
  profileFingerprint: hash,
  capabilityCatalogFingerprint: "b".repeat(64),
  executionBoundaryRevision: "boundary-1",
  capabilityId: "tavily.search.read",
  operation: "search",
  resource: "https://api.tavily.com/search",
  audience: { tenantId: "tenant-a", environmentId: "env-a" },
  brokerAuthority: { authorityId: "broker-a", revision: "broker-1" },
  credentialReference: { credentialId: "tool.tavily.default", revision: "credential-1" },
  policyRevision: "policy-1",
};

test("lease coordinator durably reserves before provider and commits result before success", async () => {
  const store = new FakeLeaseStore();
  const events: string[] = [];
  const coordinator = createCoordinator(store, events);
  const issued = await coordinator.request({
    binding,
    expiresAt: "2026-08-23T12:01:00.000Z",
    requestLimit: 1,
    responseByteLimit: 4096,
  });
  assert.equal(issued.transition, "issued");

  const invoking = await coordinator.reserveInvocation(issued.leaseId, binding);
  assert.equal(invoking.transition, "invoking");
  assert.equal(invoking.usage.requestsConsumed, 1);

  const result = { version: 1, results: [{ title: "A" }] };
  const exhausted = await coordinator.commitResult({
    leaseId: issued.leaseId,
    expectedBinding: binding,
    result,
    responseBytes: Buffer.byteLength(JSON.stringify(result)),
  });
  assert.equal(exhausted.transition, "exhausted");
  assert.equal(exhausted.terminalOutcome, "completed");
  assert.ok(exhausted.result);
  assert.deepEqual(events, ["requested", "issued", "invoking", "consumed", "exhausted"]);
});

test("lease coordinator revokes ambiguous invoking recovery without provider retry", async () => {
  const store = new FakeLeaseStore();
  const coordinator = createCoordinator(store);
  const issued = await coordinator.request({
    binding,
    expiresAt: "2026-08-23T12:01:00.000Z",
    requestLimit: 1,
    responseByteLimit: 4096,
  });
  await coordinator.reserveInvocation(issued.leaseId, binding);
  const recovery = await coordinator.recover(issued.leaseId, binding);
  assert.equal(recovery.kind, "denied");
  assert.equal(recovery.lease.transition, "revoked");
  assert.equal(recovery.lease.terminalReason, "ambiguous_provider_invocation_after_crash");
});

test("lease coordinator refuses an expired lease before provider invocation", async () => {
  const store = new FakeLeaseStore();
  const coordinator = createCoordinator(store);
  const lease = await coordinator.request({
    binding,
    expiresAt: "2026-08-23T12:00:00.000Z",
    requestLimit: 1,
    responseByteLimit: 4096,
  });

  assert.equal(lease.transition, "cleaned");
  assert.equal(lease.terminalOutcome, "expired");
  assert.equal(lease.terminalReason, "lease_expired");
});

test("lease coordinator rejects a provider result beyond the response-byte ceiling", async () => {
  const store = new FakeLeaseStore();
  const coordinator = createCoordinator(store);
  const issued = await coordinator.request({
    binding,
    expiresAt: "2026-08-23T12:01:00.000Z",
    requestLimit: 1,
    responseByteLimit: 4,
  });
  await coordinator.reserveInvocation(issued.leaseId, binding);

  await assert.rejects(
    coordinator.commitResult({
      leaseId: issued.leaseId,
      expectedBinding: binding,
      result: { too: "large" },
      responseBytes: 5,
    }),
    /response byte ceiling is exhausted/u,
  );
  assert.equal((await store.getSandboxCapabilityLease(issued.leaseId))?.transition, "exhausted");
});

test("lease coordinator fails stale binding closed and disposes secrets before cleaned", async () => {
  const store = new FakeLeaseStore();
  const order: string[] = [];
  const coordinator = createCoordinator(store, order);
  const issued = await coordinator.request({
    binding,
    expiresAt: "2026-08-23T12:01:00.000Z",
    requestLimit: 1,
    responseByteLimit: 4096,
  });
  await assert.rejects(
    coordinator.reserveInvocation(issued.leaseId, { ...binding, runId: "other-run" }),
    /exact action/u,
  );
  await coordinator.settleBeforeTeardown({
    leaseId: issued.leaseId,
    expectedBinding: binding,
    reason: "cancelled",
    disposeSensitiveMaterial: () => { order.push("secret_disposed"); },
  });
  assert.deepEqual(order.slice(-3), ["cancelled", "secret_disposed", "cleaned"]);
});

class FakeLeaseStore implements SandboxCapabilityLeaseStore {
  private readonly transitions = new Map<string, SandboxCapabilityLeaseTransitionRecordV1[]>();
  private readonly childReservations = new Map<string, SandboxCapabilityChildReservationV1>();

  async appendSandboxCapabilityLeaseTransition(input: { expectedSequence: number; record: SandboxCapabilityLeaseTransitionRecordV1 }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const records = this.transitions.get(input.record.leaseId) ?? [];
    assert.equal(records.at(-1)?.sequence ?? 0, input.expectedSequence);
    assert.equal(input.record.sequence, input.expectedSequence + 1);
    records.push(structuredClone(input.record));
    this.transitions.set(input.record.leaseId, records);
    return structuredClone(input.record);
  }
  async getSandboxCapabilityLease(leaseId: string): Promise<SandboxCapabilityLeaseTransitionRecordV1 | null> {
    return structuredClone(this.transitions.get(leaseId)?.at(-1) ?? null);
  }
  async listSandboxCapabilityLeaseTransitions(leaseId: string): Promise<SandboxCapabilityLeaseTransitionRecordV1[]> {
    return structuredClone(this.transitions.get(leaseId) ?? []);
  }
  async listRecoverableSandboxCapabilityLeases(): Promise<SandboxCapabilityLeaseTransitionRecordV1[]> {
    return [];
  }
  async reserveSandboxCapabilityChild(input: { reservation: SandboxCapabilityChildReservationV1 }): Promise<SandboxCapabilityChildReservationV1> {
    this.childReservations.set(input.reservation.reservationId, structuredClone(input.reservation));
    return structuredClone(input.reservation);
  }
  async settleSandboxCapabilityChild(input: { reservationId: string; expectedSequence: number; status: "committed" | "released"; requestsCommitted: number; responseBytesCommitted: number; reason?: string; occurredAt: string }): Promise<SandboxCapabilityChildReservationV1> {
    const current = this.childReservations.get(input.reservationId)!;
    const next = { ...current, sequence: input.expectedSequence + 1, status: input.status, requestsCommitted: input.requestsCommitted, responseBytesCommitted: input.responseBytesCommitted, ...(input.reason === undefined ? {} : { reason: input.reason }), occurredAt: input.occurredAt };
    this.childReservations.set(input.reservationId, next);
    return structuredClone(next);
  }
  async getSandboxCapabilityChildReservation(reservationId: string): Promise<SandboxCapabilityChildReservationV1 | null> {
    return structuredClone(this.childReservations.get(reservationId) ?? null);
  }
  async listSandboxCapabilityChildReservations(parentLeaseId: string): Promise<SandboxCapabilityChildReservationV1[]> {
    return structuredClone([...this.childReservations.values()].filter((item) => item.decision.parentLeaseId === parentLeaseId));
  }
}

function createCoordinator(store: SandboxCapabilityLeaseStore, order: string[] = []): SandboxCapabilityLeaseCoordinator {
  return new SandboxCapabilityLeaseCoordinator({
    store,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
    validateCurrent: async () => ({ authorized: true }),
    persistResult: async ({ leaseId, result }) => ({
      digest: digestSandboxCapabilityResult(result),
      reference: `sandbox-capability-result:${leaseId}`,
    }),
    appendTransitionEvent: async (record) => { order.push(record.transition); },
  });
}
