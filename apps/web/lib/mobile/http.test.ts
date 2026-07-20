import assert from "node:assert/strict";
import test from "node:test";
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
