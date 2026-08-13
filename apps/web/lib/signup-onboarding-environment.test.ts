import assert from "node:assert/strict";
import test from "node:test";
import { startOrRecoverSignupEnvironment } from "./signup-onboarding-environment";

function dependencies(input?: {
  deploymentEnabled?: boolean;
  organizationEnabled?: boolean;
  operationId?: string | null;
}) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      getRollout: async () => {
        calls.push("rollout");
        return {
          deploymentEnabled: input?.deploymentEnabled ?? true,
          organizationEnabled: input?.organizationEnabled ?? true,
        };
      },
      enableRollout: async () => {
        calls.push("enable");
      },
      ensureDefault: async () => {
        calls.push("ensure");
        const operationId =
          input?.operationId === undefined ? "operation-1" : input.operationId;
        return {
          environment: { id: "environment-1" },
          operation: operationId ? { id: operationId } : null,
        };
      },
      enqueue: async (operationId: string) => {
        calls.push(`enqueue:${operationId}`);
      },
      recoverDefault: async () => {
        calls.push("recover");
      },
    },
  };
}

test("signup creates and dispatches its deferred default Environment", async () => {
  const fixture = dependencies({ organizationEnabled: false });
  const result = await startOrRecoverSignupEnvironment(
    { organizationId: "organization-1", userId: "user-1" },
    fixture.value,
  );

  assert.deepEqual(fixture.calls, [
    "rollout",
    "enable",
    "ensure",
    "enqueue:operation-1",
  ]);
  assert.deepEqual(result, {
    action: "created",
    environmentId: "environment-1",
    operationId: "operation-1",
  });
});

test("signup recovers an existing default Environment", async () => {
  const fixture = dependencies({ operationId: null });
  const result = await startOrRecoverSignupEnvironment(
    { organizationId: "organization-1", userId: "user-1" },
    fixture.value,
  );

  assert.deepEqual(fixture.calls, ["rollout", "ensure", "recover"]);
  assert.deepEqual(result, {
    action: "recovered",
    environmentId: "environment-1",
  });
});

test("signup leaves Environment state untouched when hosted execution is disabled", async () => {
  const fixture = dependencies({ deploymentEnabled: false });
  const result = await startOrRecoverSignupEnvironment(
    { organizationId: "organization-1", userId: "user-1" },
    fixture.value,
  );

  assert.deepEqual(fixture.calls, ["rollout"]);
  assert.deepEqual(result, { action: "deployment_disabled" });
});
