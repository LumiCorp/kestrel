import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEnvironmentTransition,
  assertWorkspaceTransition,
  createEnvironmentInputSchema,
  EnvironmentContractError,
  environmentActivationEventSchema,
  toEnvironmentSlug,
  workspaceSourceSchema,
} from "./contracts";

test("environment and workspace lifecycles allow owned transitions", () => {
  assert.doesNotThrow(() =>
    assertEnvironmentTransition("requested", "provisioning")
  );
  assert.doesNotThrow(() => assertEnvironmentTransition("degraded", "ready"));
  assert.doesNotThrow(() => assertWorkspaceTransition("stopped", "starting"));
  assert.doesNotThrow(() => assertWorkspaceTransition("ready", "stopping"));
});

test("terminal lifecycle states reject resurrection", () => {
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

test("environment creation requires an explicit provider region", () => {
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
});

test("workspace sources distinguish blank state from a selected GitHub repo", () => {
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

test("activation events carry the exact execution identity", () => {
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

test("environment slugs are deterministic and reject non-letter names", () => {
  assert.equal(toEnvironmentSlug("Product Development"), "product-development");
  assert.throws(() => toEnvironmentSlug("1234"), EnvironmentContractError);
});
