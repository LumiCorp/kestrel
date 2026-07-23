import assert from "node:assert/strict";
import test from "node:test";
import { runFlyOrganizationMetering } from "./fly-metering-coordinator";

test("Fly metering creates one distinct provider for each organization", async () => {
  const created: string[] = [];
  const metered: string[] = [];
  const result = await runFlyOrganizationMetering({
    organizationIds: ["organization-a", "organization-a", "organization-b"],
    createProvider: async (organizationId) => {
      created.push(organizationId);
      return { organizationId };
    },
    meterOrganization: async ({ organizationId, provider }) => {
      assert.equal(provider.organizationId, organizationId);
      metered.push(organizationId);
      return `${organizationId}-usage`;
    },
  });

  assert.deepEqual(created, ["organization-a", "organization-b"]);
  assert.deepEqual(metered, ["organization-a", "organization-b"]);
  assert.deepEqual(result, {
    results: [
      { organizationId: "organization-a", result: "organization-a-usage" },
      { organizationId: "organization-b", result: "organization-b-usage" },
    ],
    failures: [],
  });
});

test("Fly metering continues after one organization connection fails", async () => {
  const metered: string[] = [];
  const failures: Array<{ organizationId: string; message: string }> = [];
  const result = await runFlyOrganizationMetering({
    organizationIds: ["organization-broken", "organization-healthy"],
    createProvider: async (organizationId) => {
      if (organizationId === "organization-broken") {
        throw new Error("Fly provider connection is not configured.");
      }
      return { organizationId };
    },
    meterOrganization: async ({ organizationId }) => {
      metered.push(organizationId);
      return 1;
    },
    onFailure: (failure) => failures.push(failure),
  });

  assert.deepEqual(metered, ["organization-healthy"]);
  assert.deepEqual(failures, [{
    organizationId: "organization-broken",
    message: "Fly provider connection is not configured.",
  }]);
  assert.deepEqual(result.failures, failures);
});
