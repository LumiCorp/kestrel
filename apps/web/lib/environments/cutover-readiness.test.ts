import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateHostedEnvironmentCutoverReadiness,
  evaluateHostedEnvironmentSchemaReadiness,
  type HostedEnvironmentCutoverSnapshot,
} from "./cutover-readiness";

test("hosted preparation requires every Environment and GitHub migration relation", () => {
  assert.deepEqual(evaluateHostedEnvironmentSchemaReadiness([]), {
    ready: true,
    missingRelations: [],
  });
  assert.deepEqual(
    evaluateHostedEnvironmentSchemaReadiness([
      "github_action_approvals",
      "organization_feature_flags",
    ]),
    {
      ready: false,
      missingRelations: [
        "github_action_approvals",
        "organization_feature_flags",
      ],
    }
  );
});

function validSnapshot(
  overrides: Partial<HostedEnvironmentCutoverSnapshot> = {}
): HostedEnvironmentCutoverSnapshot {
  return {
    enabledOrganizationCount: 1,
    enabledOrganizationWithoutReadyDefaultCount: 0,
    invalidProjectBindingCount: 0,
    invalidThreadBindingCount: 0,
    invalidExecutionCount: 0,
    activeExecutionCount: 0,
    enabledOrganizationThreadCount: 12,
    boundThreadCount: 3,
    terminalExecutionCount: 2,
    ...overrides,
  };
}

test("cutover readiness permits historical Threads to remain lazily unbound", () => {
  assert.deepEqual(evaluateHostedEnvironmentCutoverReadiness(validSnapshot()), {
    ready: true,
    blockers: [],
    snapshot: validSnapshot(),
  });
});

test("cutover readiness fails closed on missing defaults and relational drift", () => {
  const result = evaluateHostedEnvironmentCutoverReadiness(
    validSnapshot({
      enabledOrganizationWithoutReadyDefaultCount: 2,
      invalidProjectBindingCount: 1,
      invalidThreadBindingCount: 3,
      invalidExecutionCount: 4,
    })
  );
  assert.equal(result.ready, false);
  assert.equal(result.blockers.length, 4);
  assert.match(result.blockers[0] ?? "", /2 enabled organization/u);
  assert.match(result.blockers[1] ?? "", /1 Project Environment binding/u);
  assert.match(result.blockers[2] ?? "", /3 Thread execution binding/u);
  assert.match(result.blockers[3] ?? "", /4 Environment execution record/u);
});

test("cutover readiness requires an enabled organization and a quiet execution boundary", () => {
  const result = evaluateHostedEnvironmentCutoverReadiness(
    validSnapshot({
      enabledOrganizationCount: 0,
      activeExecutionCount: 2,
    })
  );
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, [
    "No organization has the hosted Environments feature enabled.",
    "2 Environment execution(s) are still routed or running.",
  ]);
});
