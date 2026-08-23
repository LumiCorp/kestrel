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
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";

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

test("issuance failures terminalize requested authority and never strand child capacity", async () => {
  const validationStore = new InMemorySessionStore();
  const validationFailure = new SandboxCapabilityLeaseCoordinator({
    store: validationStore,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
    validateCurrent: async () => { throw new Error("credential resolver unavailable"); },
    persistResult: async () => ({ digest: hash, reference: "unused" }),
  });
  await assert.rejects(validationFailure.request({ binding, expiresAt: "2026-08-23T12:01:00.000Z", requestLimit: 1, responseByteLimit: 4096 }), /credential resolver unavailable/u);
  assert.equal((await validationStore.listRecoverableSandboxCapabilityLeases({ before: "2026-08-23T12:01:00.000Z" })).length, 0);
  assert.deepEqual(validationStore.getRunEvents().filter((event) => event.type.startsWith("sandbox_capability.")).map((event) => event.type), ["sandbox_capability.requested", "sandbox_capability.denied", "sandbox_capability.cleaned"]);

  const childStore = new InMemorySessionStore();
  const childFailure = new SandboxCapabilityLeaseCoordinator({
    store: childStore,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
    validateCurrent: async () => ({ authorized: true }),
    persistResult: async () => ({ digest: hash, reference: "unused" }),
  });
  const childBinding: SandboxCapabilityLeaseBindingV1 = {
    ...binding,
    approval: { approvalId: "child-approval", authorityRevision: "child-authority" },
    parentAuthorization: { leaseId: "missing-parent", bindingDigest: hash, authorizationDecisionId: "child-decision", reservationId: "child-reservation", requestLimit: 1, responseByteLimit: 4096 },
  };
  await assert.rejects(childFailure.request({ binding: childBinding, expiresAt: "2026-08-23T12:01:00.000Z", requestLimit: 1, responseByteLimit: 4096 }), /unavailable or stale/u);
  assert.equal(await childStore.getSandboxCapabilityChildReservation("child-reservation"), null);
  assert.equal((await childStore.listRecoverableSandboxCapabilityLeases({ before: "2026-08-23T12:01:00.000Z" })).length, 0);
});

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

test("lease coordinator revalidates policy authority at issue, invocation, result, and recovery boundaries", async () => {
  const store = new FakeLeaseStore();
  let authorized = false;
  const coordinator = new SandboxCapabilityLeaseCoordinator({
    store,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
    validateCurrent: async () => authorized
      ? { authorized: true }
      : { authorized: false, reason: "prepared_policy_changed_or_denied" },
    persistResult: async ({ leaseId, result }) => ({ digest: digestSandboxCapabilityResult(result), reference: `result:${leaseId}` }),
  });

  const deniedAtIssue = await coordinator.request({ binding: { ...binding, toolCallId: "issue-denied" }, expiresAt: "2026-08-23T12:01:00.000Z", requestLimit: 1, responseByteLimit: 4096 });
  assert.equal(deniedAtIssue.transition, "cleaned");
  assert.equal(deniedAtIssue.terminalReason, "prepared_policy_changed_or_denied");

  authorized = true;
  const invocationLease = await coordinator.request({ binding: { ...binding, toolCallId: "invoke-denied" }, expiresAt: "2026-08-23T12:01:00.000Z", requestLimit: 1, responseByteLimit: 4096 });
  authorized = false;
  await assert.rejects(coordinator.reserveInvocation(invocationLease.leaseId, invocationLease.binding), /no longer current/u);
  assert.equal((await store.getSandboxCapabilityLease(invocationLease.leaseId))?.transition, "revoked");

  authorized = true;
  const resultLease = await coordinator.request({ binding: { ...binding, toolCallId: "result-denied" }, expiresAt: "2026-08-23T12:01:00.000Z", requestLimit: 1, responseByteLimit: 4096 });
  await coordinator.reserveInvocation(resultLease.leaseId, resultLease.binding);
  authorized = false;
  await assert.rejects(coordinator.commitResult({ leaseId: resultLease.leaseId, expectedBinding: resultLease.binding, result: { results: [] }, responseBytes: 2 }), /no longer authorized/u);
  assert.equal((await store.getSandboxCapabilityLease(resultLease.leaseId))?.transition, "revoked");

  authorized = true;
  const recoveryLease = await coordinator.request({ binding: { ...binding, toolCallId: "recovery-denied" }, expiresAt: "2026-08-23T12:01:00.000Z", requestLimit: 1, responseByteLimit: 4096 });
  authorized = false;
  const recovery = await coordinator.recover(recoveryLease.leaseId, recoveryLease.binding);
  assert.equal(recovery.kind, "denied");
  assert.equal(recovery.lease.transition, "revoked");
  assert.equal(recovery.lease.terminalReason, "prepared_policy_changed_or_denied");

  authorized = true;
  const replayLease = await coordinator.request({ binding: { ...binding, toolCallId: "replay-denied" }, expiresAt: "2026-08-23T12:01:00.000Z", requestLimit: 1, responseByteLimit: 4096 });
  await coordinator.reserveInvocation(replayLease.leaseId, replayLease.binding);
  await coordinator.commitResult({ leaseId: replayLease.leaseId, expectedBinding: replayLease.binding, result: { results: [] }, responseBytes: 2 });
  authorized = false;
  const replay = await coordinator.recover(replayLease.leaseId, replayLease.binding);
  assert.equal(replay.kind, "denied");
  assert.equal(replay.lease.transition, "revoked");
  assert.equal(replay.lease.terminalOutcome, "revoked");
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
  async issueSandboxCapabilityLease(input: { expectedSequence: number; record: SandboxCapabilityLeaseTransitionRecordV1; childReservation?: SandboxCapabilityChildReservationV1 }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    if (input.childReservation !== undefined) this.childReservations.set(input.childReservation.reservationId, structuredClone(input.childReservation));
    return this.appendSandboxCapabilityLeaseTransition(input);
  }
  async reserveSandboxCapabilityInvocation(input: { expectedSequence: number; record: SandboxCapabilityLeaseTransitionRecordV1 }): Promise<SandboxCapabilityLeaseTransitionRecordV1 & { invocationResponseByteLimit: number }> {
    return { ...await this.appendSandboxCapabilityLeaseTransition(input), invocationResponseByteLimit: input.record.usage.responseByteLimit - input.record.usage.responseBytesConsumed };
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
  async saveSandboxCapabilityEffectResult(): Promise<void> {}
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
