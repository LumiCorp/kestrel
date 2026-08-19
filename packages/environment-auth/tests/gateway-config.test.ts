import assert from "node:assert/strict";
import test from "node:test";
import {
  ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS,
  ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION,
  EnvironmentGatewayConfigParseError,
  parseEnvironmentGatewayConfig,
  serializeEnvironmentGatewayConfig,
} from "../src/gateway-config.js";

const legacyBase = {
  environmentId: "environment-test",
  revision: "revision-test",
  workspaces: [],
  previews: [],
  modelGrants: [],
};

test("gateway config v2 normalizes to the current internal contract", () => {
  assert.deepEqual(parseEnvironmentGatewayConfig({ version: 2, ...legacyBase }), {
    version: 3,
    ...legacyBase,
    appGrants: [],
  });
});

test("gateway config v4 round trips through the producer serializer", () => {
  const serialized = serializeEnvironmentGatewayConfig({
    environmentId: "environment-test",
    gatewayId: "gateway-resource-id",
    revision: "a".repeat(64),
    routeGeneration: "b".repeat(64),
    workspaces: [{
      id: "workspace-1",
      serviceTokenHash: "A".repeat(43),
      backend: {
        kind: "private_dns",
        hostname: "machine-1.vm.kestrel-env.internal",
        port: 43_104,
        computeResourceId: "compute-resource-id",
        desiredRevision: "sha256:image",
      },
    }],
    previews: [],
    modelGrants: [],
    appGrants: [],
  });
  assert.equal(serialized.version, ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION);
  assert.deepEqual(parseEnvironmentGatewayConfig(serialized), serialized);
  assert.equal(
    ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS.includes(
      ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION,
    ),
    true,
  );
});

test("gateway config reports unsupported versions separately from invalid payloads", () => {
  assert.throws(
    () => parseEnvironmentGatewayConfig({ version: 5, ...legacyBase }),
    (error) =>
      error instanceof EnvironmentGatewayConfigParseError &&
      error.code === "UNSUPPORTED_VERSION" &&
      error.receivedVersion === 5,
  );
  assert.throws(
    () => parseEnvironmentGatewayConfig({ version: 3 }),
    (error) =>
      error instanceof EnvironmentGatewayConfigParseError &&
      error.code === "INVALID_CONFIG",
  );
});

test("gateway config v4 rejects provider topology and duplicate compute authority", () => {
  const workspace = (id: string) => ({
    id,
    serviceTokenHash: "A".repeat(43),
    backend: {
      kind: "private_dns" as const,
      hostname: `${id}.namespace.svc.cluster.local`,
      port: 43_104,
      computeResourceId: "same-compute-resource",
      desiredRevision: "sha256:image",
    },
  });
  const base = {
    version: 4,
    environmentId: "environment-test",
    gatewayId: "gateway-resource-id",
    revision: "a".repeat(64),
    routeGeneration: "b".repeat(64),
    workspaces: [workspace("workspace-1")],
    previews: [],
    modelGrants: [],
    appGrants: [],
  };
  assert.throws(() => parseEnvironmentGatewayConfig({ ...base, provider: "kubernetes" }));
  assert.throws(() => parseEnvironmentGatewayConfig({
    ...base,
    workspaces: [workspace("workspace-1"), workspace("workspace-2")],
  }));
  assert.throws(() => parseEnvironmentGatewayConfig({
    ...base,
    workspaces: [{
      ...workspace("workspace-1"),
      backend: { ...workspace("workspace-1").backend, hostname: "127.0.0.1" },
    }],
  }));
});
