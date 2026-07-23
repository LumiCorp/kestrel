import assert from "node:assert/strict";
import {
  assertEnvironmentTransition,
  assertWorkspaceTransition,
  createEnvironmentInputSchema,
  deleteEnvironmentInputSchema,
  EnvironmentContractError,
  environmentDeleteIdempotencyKey,
  environmentActivationEventSchema,
  selectDefaultEnvironmentRecoveryAction,
  toEnvironmentSlug,
  workspaceSourceSchema,
} from "./contracts";
import { DEFAULT_FLY_REGION, FLY_REGIONS } from "./regions";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "environment and workspace lifecycles allow owned transitions", () => {
  assert.doesNotThrow(() =>
    assertEnvironmentTransition("requested", "provisioning")
  );
  assert.doesNotThrow(() => assertEnvironmentTransition("degraded", "ready"));
  assert.doesNotThrow(() => assertWorkspaceTransition("stopped", "starting"));
  assert.doesNotThrow(() => assertWorkspaceTransition("ready", "stopping"));
});

contractTest("web.hermetic", "terminal lifecycle states reject resurrection", () => {
  assert.throws(
    () => assertEnvironmentTransition("deleted", "ready"),
    (error: unknown) =>
      error instanceof EnvironmentContractError &&
      error.code === "ENVIRONMENT_INVALID_TRANSITION"
  );
  assert.throws(
    () => assertWorkspaceTransition("deleted", "starting"),
    (error: unknown) =>
      error instanceof EnvironmentContractError &&
      error.code === "WORKSPACE_INVALID_TRANSITION"
  );
});

contractTest("web.hermetic", "environment creation requires an explicit provider region", () => {
  assert.equal(
    createEnvironmentInputSchema.safeParse({ name: "Development" }).success,
    false
  );
  assert.deepEqual(
    createEnvironmentInputSchema.parse({
      name: "Development",
      region: "iad",
    }),
    { name: "Development", region: "iad" }
  );
  assert.equal(
    createEnvironmentInputSchema.safeParse({
      name: "Development",
      region: "unknown",
    }).success,
    false
  );
});

contractTest("web.hermetic", "environment deletion requires an exact confirmation value", () => {
  assert.deepEqual(
    deleteEnvironmentInputSchema.parse({ confirmationName: "Development" }),
    { confirmationName: "Development" }
  );
  assert.equal(
    deleteEnvironmentInputSchema.safeParse({ confirmationName: "" }).success,
    false
  );
  assert.equal(
    environmentDeleteIdempotencyKey("environment-id"),
    "environment.delete:environment-id"
  );
});

contractTest("web.hermetic", "Fly region choices have unique codes and include the default", () => {
  const codes = FLY_REGIONS.map((region) => region.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(codes.includes(DEFAULT_FLY_REGION), true);
});

contractTest("web.hermetic", "workspace sources distinguish blank state from a selected GitHub repo", () => {
  assert.deepEqual(workspaceSourceSchema.parse({ type: "blank" }), {
    type: "blank",
  });
  assert.equal(
    workspaceSourceSchema.safeParse({
      type: "github",
      resourceId: "11111111-1111-4111-8111-111111111111",
    }).success,
    true
  );
  assert.equal(
    workspaceSourceSchema.safeParse({
      type: "github",
      resourceId: "github-installation-1",
    }).success,
    false
  );
});

contractTest("web.hermetic", "activation events carry the exact execution identity", () => {
  const event = environmentActivationEventSchema.parse({
    operationId: "123e4567-e89b-12d3-a456-426614174000",
    environmentId: "123e4567-e89b-12d3-a456-426614174001",
    workspaceId: "123e4567-e89b-12d3-a456-426614174002",
    threadId: "123e4567-e89b-12d3-a456-426614174003",
    stage: "environment.machine.starting",
    occurredAt: "2026-07-12T12:00:00.000Z",
  });
  assert.equal(event.threadId, "123e4567-e89b-12d3-a456-426614174003");
});

contractTest("web.hermetic", "environment slugs are deterministic and reject non-letter names", () => {
  assert.equal(toEnvironmentSlug("Product Development"), "product-development");
  assert.throws(() => toEnvironmentSlug("1234"), EnvironmentContractError);
});

contractTest("web.hermetic", "default Environment recovery is idempotent by lifecycle state", () => {
  assert.equal(
    selectDefaultEnvironmentRecoveryAction({
      environmentStatus: "ready",
      operationStatus: "completed",
    }),
    "ready"
  );
  for (const operationStatus of ["queued", "running"] as const) {
    assert.equal(
      selectDefaultEnvironmentRecoveryAction({
        environmentStatus: "provisioning",
        operationStatus,
      }),
      "existing"
    );
  }
  for (const operationStatus of ["failed", "cancelled"] as const) {
    assert.equal(
      selectDefaultEnvironmentRecoveryAction({
        environmentStatus: "failed",
        operationStatus,
      }),
      "requeue"
    );
  }
  assert.equal(
    selectDefaultEnvironmentRecoveryAction({
      environmentStatus: "degraded",
      operationStatus: "failed",
    }),
    "unsupported"
  );
});
