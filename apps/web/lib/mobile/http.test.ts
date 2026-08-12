import test from "node:test";
import assert from "node:assert/strict";
import { mobileErrorResponse } from "./http";
import { MobileSessionError } from "./session";


test("only tagged session failures become 401", async () => {
  const sessionResponse = mobileErrorResponse(
    new MobileSessionError("UNAUTHORIZED", "Mobile session required")
  );
  assert.equal(sessionResponse.status, 401);
  assert.equal((await sessionResponse.json()).error.code, "UNAUTHORIZED");

  for (const unrelated of [
    new Error("Unauthorized"),
    new Error("Invalid API key."),
    new Error("database unavailable"),
  ]) {
    assert.equal(mobileErrorResponse(unrelated).status, 500);
  }
});

test("organization failures have distinct public responses", async () => {
  const membership = mobileErrorResponse(
    new MobileSessionError(
      "ORGANIZATION_MEMBERSHIP_REQUIRED",
      "Organization membership required"
    )
  );
  assert.equal(membership.status, 403);
  assert.equal(
    (await membership.json()).error.code,
    "ORGANIZATION_MEMBERSHIP_REQUIRED"
  );

  const configuration = mobileErrorResponse(
    new MobileSessionError(
      "ORGANIZATION_CONFIGURATION_ERROR",
      "Unable to configure organization"
    )
  );
  assert.equal(configuration.status, 503);
  assert.equal(
    (await configuration.json()).error.code,
    "ORGANIZATION_CONFIGURATION_ERROR"
  );
});

test("Runtime binding admission failures remain conflicts", async () => {
  for (const code of [
    "RUNTIME_BINDING_IMMUTABLE",
    "RUNTIME_BINDING_DEGRADED",
    "RUNTIME_RECOVERY_UNAVAILABLE",
    "RUNTIME_UNAVAILABLE",
  ]) {
    const response = mobileErrorResponse(
      Object.assign(new Error("Runtime admission rejected."), { code }),
      400,
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "CONFLICT");
  }
});
