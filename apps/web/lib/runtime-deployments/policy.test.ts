import assert from "node:assert/strict";
import test from "node:test";
import {
  fanoutStatus,
  selectRuntimeDeploymentScope,
  shouldAssignRuntimeTarget,
} from "./policy";

test("canary phase targets only the persistent canary", () => {
  const scope = selectRuntimeDeploymentScope({
    status: "canary",
    canaryEnvironmentId: "canary",
    environments: [{ id: "canary" }, { id: "other" }],
  });
  assert.equal(scope.canaryOnly, true);
  assert.deepEqual(scope.environments, [{ id: "canary" }]);
});

test("fanout targets all Environments and one block degrades without stopping peers", () => {
  const scope = selectRuntimeDeploymentScope({
    status: "fanout",
    canaryEnvironmentId: "canary",
    environments: [{ id: "canary" }, { id: "a" }, { id: "b" }],
  });
  assert.deepEqual(
    scope.environments.map((environment) => environment.id),
    ["canary", "a", "b"],
  );
  assert.equal(
    fanoutStatus({
      blockedResourceCount: 1,
      convergedEnvironmentCount: 2,
      eligibleEnvironmentCount: 3,
    }),
    "degraded",
  );
});

test("new generations supersede old targets while resource rollback pins the current generation", () => {
  const base = {
    status: "degraded" as const,
    generation: 4,
    targetSourceRevision: "a".repeat(40),
    desiredSourceRevision: "b".repeat(40),
    targetRouterImage: "prior-router",
    desiredRouterImage: "desired-router",
    targetRuntimeImage: "prior-runtime",
    desiredRuntimeImage: "desired-runtime",
  };
  assert.equal(
    shouldAssignRuntimeTarget({ ...base, targetGeneration: 3 }),
    true,
  );
  assert.equal(
    shouldAssignRuntimeTarget({ ...base, targetGeneration: 4 }),
    false,
  );
});
