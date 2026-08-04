import assert from "node:assert/strict";
import test from "node:test";

import {
  BUDGET_SCOPE_VERSION,
  BUDGET_USAGE_VERSION,
  createBudgetPolicyV1,
  type BudgetPolicyV1,
  type BudgetScopeV1,
} from "../../src/kestrel/contracts/budget.js";
import {
  BudgetCoordinator,
  BudgetIntegrityError,
  type CommitBudgetReservationInputV1,
} from "../../src/budget/BudgetCoordinator.js";
import { InMemoryBudgetRepository } from "../../src/budget/InMemoryBudgetRepository.js";

const at = "2026-08-04T12:00:00.000Z";

function fixtures(): { policy: BudgetPolicyV1; tenant: BudgetScopeV1; run: BudgetScopeV1; model: BudgetScopeV1 } {
  const tenant: BudgetScopeV1 = {
    version: BUDGET_SCOPE_VERSION,
    segments: [{ kind: "tenant", id: "tenant-1" }],
  };
  const run: BudgetScopeV1 = {
    version: BUDGET_SCOPE_VERSION,
    segments: [...tenant.segments, { kind: "run", id: "run-1" }],
  };
  const model: BudgetScopeV1 = {
    version: BUDGET_SCOPE_VERSION,
    segments: [
      ...run.segments,
      { kind: "agent", id: "agent-1" },
      { kind: "subagent", id: "subagent-root" },
      { kind: "model", id: "model-openai" },
    ],
  };
  return {
    tenant,
    run,
    model,
    policy: createBudgetPolicyV1({
      policyId: "budget-policy",
      allocations: [
        { allocationKey: "tenant", scope: tenant, limits: { modelCalls: 5, inputTokens: 1_000, modelCostMicroUsd: 50_000 } },
        { allocationKey: "run", parentAllocationKey: "tenant", scope: run, limits: { modelCalls: 3, inputTokens: 700, modelCostMicroUsd: 30_000 } },
      ],
    }),
  };
}

async function openRun(coordinator: BudgetCoordinator, policy: BudgetPolicyV1): Promise<void> {
  await coordinator.openAllocation({
    allocationId: "allocation-tenant",
    allocationKey: "tenant",
    policyRevision: policy.revision,
    idempotencyKey: "open-tenant",
    openedAt: at,
  });
  await coordinator.openAllocation({
    allocationId: "allocation-run",
    allocationKey: "run",
    policyRevision: policy.revision,
    parentAllocationId: "allocation-tenant",
    parentAllocationRevision: 0,
    idempotencyKey: "open-run",
    openedAt: at,
  });
}

test("coordinator reserves, commits actual usage, and makes duplicate settlement idempotent", async () => {
  const { policy, model } = fixtures();
  const repository = new InMemoryBudgetRepository();
  const coordinator = new BudgetCoordinator({ policy, repository });
  await openRun(coordinator, policy);
  const reserved = await coordinator.reserve({
    allocationId: "allocation-run",
    allocationRevision: 0,
    policyRevision: policy.revision,
    reservationId: "reservation-model",
    scope: model,
    amounts: { modelCalls: 1, inputTokens: 200, modelCostMicroUsd: 10_000 },
    idempotencyKey: "reserve-model",
    createdAt: at,
  });
  assert.equal(reserved.status, "reserved");
  assert.deepEqual(reserved.snapshot.reserved, { modelCalls: 1, inputTokens: 200, modelCostMicroUsd: 10_000 });
  const input: CommitBudgetReservationInputV1 = {
    allocationId: "allocation-run",
    allocationRevision: 1,
    policyRevision: policy.revision,
    reservationId: "reservation-model",
    reservationRevision: 0,
    usage: {
      version: BUDGET_USAGE_VERSION,
      usageId: "usage-model",
      allocationId: "allocation-run",
      reservationId: "reservation-model",
      policyRevision: policy.revision,
      amounts: { modelCalls: 1, inputTokens: 150, modelCostMicroUsd: 8_000 },
      unknownCosts: [],
      measuredAt: at,
    },
    idempotencyKey: "commit-model",
  };
  const first = await coordinator.commit(input);
  const duplicate = await coordinator.commit(input);
  assert.deepEqual(duplicate, first);
  assert.deepEqual(first.snapshot.reserved, { modelCalls: 0, inputTokens: 0, modelCostMicroUsd: 0 });
  assert.deepEqual(first.snapshot.committed, { modelCalls: 1, inputTokens: 150, modelCostMicroUsd: 8_000 });
  assert.equal((await repository.read()).ledger.filter((entry) => entry.operation === "reservation.committed").length, 1);
});

test("cancellation releases only the unconsumed reservation and cannot mint credit", async () => {
  const { policy, model } = fixtures();
  const repository = new InMemoryBudgetRepository();
  const coordinator = new BudgetCoordinator({ policy, repository });
  await openRun(coordinator, policy);
  await coordinator.reserve({
    allocationId: "allocation-run",
    allocationRevision: 0,
    policyRevision: policy.revision,
    reservationId: "reservation-cancel",
    scope: model,
    amounts: { modelCalls: 2 },
    idempotencyKey: "reserve-cancel",
    createdAt: at,
  });
  const releaseInput = {
    allocationId: "allocation-run",
    allocationRevision: 1,
    policyRevision: policy.revision,
    reservationId: "reservation-cancel",
    reservationRevision: 0,
    idempotencyKey: "release-cancel",
    releasedAt: at,
  };
  const released = await coordinator.release(releaseInput);
  assert.deepEqual(released.snapshot.available.modelCalls, 3);
  assert.deepEqual(await coordinator.release(releaseInput), released);
  await assert.rejects(
    coordinator.release({ ...releaseInput, idempotencyKey: "release-again", allocationRevision: 2, reservationRevision: 1 }),
    (error: unknown) => error instanceof BudgetIntegrityError && error.code === "BUDGET_RESERVATION_SETTLED",
  );
  assert.deepEqual((await coordinator.snapshot({
    allocationId: "allocation-run",
    allocationRevision: 2,
    policyRevision: policy.revision,
  })).committed, {});
});

test("atomic sibling reservations contend and a fresh over-budget request is denied", async () => {
  const { policy, model } = fixtures();
  const coordinator = new BudgetCoordinator({ policy, repository: new InMemoryBudgetRepository() });
  await openRun(coordinator, policy);
  const request = (id: string) => coordinator.reserve({
    allocationId: "allocation-run",
    allocationRevision: 0,
    policyRevision: policy.revision,
    reservationId: id,
    scope: model,
    amounts: { modelCalls: 2 },
    idempotencyKey: `reserve-${id}`,
    createdAt: at,
  });
  const concurrent = await Promise.allSettled([request("sibling-a"), request("sibling-b")]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
  const denied = await coordinator.reserve({
    allocationId: "allocation-run",
    allocationRevision: 1,
    policyRevision: policy.revision,
    reservationId: "sibling-c",
    scope: model,
    amounts: { modelCalls: 2 },
    idempotencyKey: "reserve-sibling-c",
    createdAt: at,
  });
  assert.equal(denied.status, "denied");
});

test("child allocation contention, restart, and close reconcile against the parent lineage", async () => {
  const { policy } = fixtures();
  const repository = new InMemoryBudgetRepository();
  const first = new BudgetCoordinator({ policy, repository });
  await openRun(first, policy);
  await assert.rejects(first.openAllocation({
    allocationId: "allocation-run-2",
    allocationKey: "run",
    policyRevision: policy.revision,
    parentAllocationId: "allocation-tenant",
    parentAllocationRevision: 1,
    idempotencyKey: "open-run-2",
    openedAt: at,
  }), (error: unknown) => error instanceof BudgetIntegrityError && error.code === "BUDGET_PARENT_EXHAUSTED");
  const restarted = new BudgetCoordinator({ policy, repository });
  const snapshot = await restarted.snapshot({ allocationId: "allocation-run", allocationRevision: 0, policyRevision: policy.revision });
  assert.equal(snapshot.available.modelCalls, 3);
  const closed = await restarted.closeAllocation({
    allocationId: "allocation-run",
    allocationRevision: 0,
    policyRevision: policy.revision,
    parentAllocationId: "allocation-tenant",
    parentAllocationRevision: 1,
    idempotencyKey: "close-run",
    closedAt: at,
  });
  assert.equal(closed.allocation.status, "closed");
  assert.equal(closed.parentSnapshot?.available.modelCalls, 5);
});

test("unknown price evidence fails closed only when its allocation has the matching cost ceiling", async () => {
  const { policy, model } = fixtures();
  const coordinator = new BudgetCoordinator({ policy, repository: new InMemoryBudgetRepository() });
  await openRun(coordinator, policy);
  await coordinator.reserve({
    allocationId: "allocation-run",
    allocationRevision: 0,
    policyRevision: policy.revision,
    reservationId: "reservation-unpriced",
    scope: model,
    amounts: { modelCalls: 1 },
    idempotencyKey: "reserve-unpriced",
    createdAt: at,
  });
  await assert.rejects(coordinator.commit({
    allocationId: "allocation-run",
    allocationRevision: 1,
    policyRevision: policy.revision,
    reservationId: "reservation-unpriced",
    reservationRevision: 0,
    usage: {
      version: BUDGET_USAGE_VERSION,
      usageId: "usage-unpriced",
      allocationId: "allocation-run",
      reservationId: "reservation-unpriced",
      policyRevision: policy.revision,
      amounts: { modelCalls: 1 },
      unknownCosts: [{ resource: "modelCostMicroUsd", reason: "price_unavailable" }],
      measuredAt: at,
    },
    idempotencyKey: "commit-unpriced",
  }), (error: unknown) => error instanceof BudgetIntegrityError && error.code === "BUDGET_PRICE_EVIDENCE_REQUIRED");
});
