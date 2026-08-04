import assert from "node:assert/strict";
import test from "node:test";

import {
  BUDGET_SCOPE_VERSION,
  canonicalBudgetJson,
  createBudgetPolicyV1,
  fingerprintBudgetPolicyV1,
  parseBudgetAmountsV1,
  parseBudgetPolicyV1,
  parseBudgetReservationRequestV1,
  parseBudgetScopeV1,
} from "../../src/kestrel/contracts/budget.js";

const tenantScope = {
  version: BUDGET_SCOPE_VERSION,
  segments: [{ kind: "tenant" as const, id: "tenant-1" }],
};
const runScope = {
  version: BUDGET_SCOPE_VERSION,
  segments: [
    ...tenantScope.segments,
    { kind: "run" as const, id: "run-1" },
  ],
};

test("budget policy is strict, canonical, and binds exact authored lineage", () => {
  const policy = createBudgetPolicyV1({
    policyId: "policy-1",
    allocations: [
      { allocationKey: "tenant", scope: tenantScope, limits: { modelCalls: 10, modelCostMicroUsd: 500_000 } },
      { allocationKey: "run", parentAllocationKey: "tenant", scope: runScope, limits: { modelCalls: 4, modelCostMicroUsd: 200_000 } },
    ],
  });
  assert.deepEqual(parseBudgetPolicyV1(policy), policy);
  assert.equal(fingerprintBudgetPolicyV1(policy), policy.revision);
  assert.equal(
    canonicalBudgetJson({ z: 1, nested: { z: 2, a: 1 }, a: 2 }),
    '{"a":2,"nested":{"a":1,"z":2},"z":1}',
  );
  assert.throws(() => parseBudgetPolicyV1({ ...policy, surprise: true }), /unknown field 'surprise'/u);
  assert.throws(() => parseBudgetPolicyV1({ ...policy, revision: `sha256:${"1".repeat(64)}` }), /canonical payload/u);
});

test("budget contracts reject unsafe integers and non-exact scope transitions", () => {
  assert.throws(() => parseBudgetAmountsV1({ modelCostMicroUsd: 0.5 }), /safe integer/u);
  assert.throws(() => parseBudgetAmountsV1({ modelCalls: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/u);
  assert.throws(() => parseBudgetAmountsV1({ modelCalls: 1, tokens: 2 }), /unknown field 'tokens'/u);
  assert.throws(() => parseBudgetReservationRequestV1({
    allocationId: "allocation-1",
    allocationRevision: 0,
    policyRevision: `sha256:${"0".repeat(64)}`,
    reservationId: "reservation-1",
    scope: tenantScope,
    amounts: { modelCalls: 1 },
    idempotencyKey: "reserve-1",
    ranking: 0.9,
  }), /unknown field 'ranking'/u);
  assert.throws(() => parseBudgetScopeV1({
    version: BUDGET_SCOPE_VERSION,
    segments: [
      { kind: "tenant", id: "tenant-1" },
      { kind: "agent", id: "agent-1" },
    ],
  }), /segment 1 must be 'run'/u);
  assert.throws(() => createBudgetPolicyV1({
    policyId: "policy-wide-child",
    allocations: [
      { allocationKey: "tenant", scope: tenantScope, limits: { modelCalls: 2 } },
      { allocationKey: "run", parentAllocationKey: "tenant", scope: runScope, limits: { modelCalls: 3 } },
    ],
  }), /no greater than its parent/u);
  assert.throws(() => createBudgetPolicyV1({
    policyId: "policy-unbounded-child",
    allocations: [
      { allocationKey: "tenant", scope: tenantScope, limits: { modelCalls: 2 } },
      { allocationKey: "run", parentAllocationKey: "tenant", scope: runScope, limits: {} },
    ],
  }), /must be finite/u);
});
