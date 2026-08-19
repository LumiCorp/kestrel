import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertEnvironmentProviderCompatibility,
  EnvironmentProviderCompatibilityError,
  REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES,
} from "./contracts";
import {
  compareEnvironmentEvidenceLevels,
  parseEnvironmentPlacement,
  parseEnvironmentResourceRef,
  parseEnvironmentStorageSecurity,
} from "./contracts-v2";

test("the universal Environment provider contract accepts the complete capability set", () => {
  const descriptor = {
    id: "test-provider",
    label: "Test Provider",
    capabilities: REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES,
    evidence: "implementation" as const,
  };

  assert.equal(assertEnvironmentProviderCompatibility(descriptor), descriptor);
});

test("the universal Environment provider contract reports every missing capability", () => {
  assert.throws(
    () =>
      assertEnvironmentProviderCompatibility({
        id: "partial-provider",
        label: "Partial Provider",
        capabilities: ["environment_scope", "workspace_compute"],
        evidence: "api_discovery",
      }),
    (error) => {
      assert.ok(error instanceof EnvironmentProviderCompatibilityError);
      assert.equal(error.code, "ENVIRONMENT_PROVIDER_INCOMPATIBLE");
      assert.equal(error.providerId, "partial-provider");
      assert.deepEqual(error.missingCapabilities, [
        "public_gateway",
        "private_workspace_routing",
        "workspace_start_stop",
        "persistent_workspace_storage",
        "volume_snapshots",
        "immutable_image_updates",
        "health_readiness",
        "resource_inventory",
        "regional_placement",
      ]);
      return true;
    },
  );
});

test("every required capability fails compatibility when removed individually", () => {
  for (const capability of REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES) {
    assert.throws(
      () =>
        assertEnvironmentProviderCompatibility({
          id: `missing-${capability}`,
          label: "Incomplete Provider",
          capabilities: REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES.filter(
            (candidate) => candidate !== capability,
          ),
          evidence: "implementation",
        }),
      (error) =>
        error instanceof EnvironmentProviderCompatibilityError &&
        error.missingCapabilities.length === 1 &&
        error.missingCapabilities[0] === capability,
    );
  }
});

test("v2 resource, placement, and storage security contracts are strict", () => {
  assert.deepEqual(
    parseEnvironmentResourceRef({
      provider: "kubernetes",
      role: "workspace_compute",
      externalId: "namespace/deployment",
    }),
    {
      provider: "kubernetes",
      role: "workspace_compute",
      externalId: "namespace/deployment",
    },
  );
  assert.throws(() =>
    parseEnvironmentResourceRef({
      provider: "kubernetes",
      role: "workspace_compute",
      externalId: "namespace/deployment",
      machineId: "provider-leak",
    }),
  );
  assert.throws(() =>
    parseEnvironmentPlacement({
      connectionId: "connection-1",
      requested: { location: "us-east" },
      observed: null,
      region: "iad",
    }),
  );
  assert.throws(() =>
    parseEnvironmentStorageSecurity({
      encryption: "provider_attested",
      evidenceRef: null,
    }),
  );
});

test("evidence levels cannot elevate preflight to isolated-provider proof", () => {
  assert.ok(
    compareEnvironmentEvidenceLevels(
      "cluster_preflight",
      "isolated_provider",
    ) < 0,
  );
  assert.ok(compareEnvironmentEvidenceLevels("pilot", "production") < 0);
});

test("the shared v2 contract cannot regain Fly-specific field names", () => {
  const source = readFileSync(new URL("./contracts-v2.ts", import.meta.url), "utf8");
  for (const forbidden of ["appName", "machineId", "volumeId", "region"]) {
    assert.doesNotMatch(source, new RegExp(`\\b${forbidden}\\b`, "u"));
  }
});
