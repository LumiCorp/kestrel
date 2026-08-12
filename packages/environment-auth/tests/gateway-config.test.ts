import assert from "node:assert/strict";
import test from "node:test";
import {
  ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS,
  ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION,
  EnvironmentGatewayConfigParseError,
  parseEnvironmentGatewayConfig,
  serializeEnvironmentGatewayConfig,
} from "../src/gateway-config.js";

const base = {
  environmentId: "environment-test",
  revision: "revision-test",
  workspaces: [],
  previews: [],
  modelGrants: [],
};

test("gateway config v2 normalizes to the current internal contract", () => {
  assert.deepEqual(parseEnvironmentGatewayConfig({ version: 2, ...base }), {
    version: 3,
    ...base,
    appGrants: [],
  });
});

test("gateway config v3 round trips through the producer serializer", () => {
  const serialized = serializeEnvironmentGatewayConfig({
    ...base,
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
    () => parseEnvironmentGatewayConfig({ version: 4, ...base }),
    (error) =>
      error instanceof EnvironmentGatewayConfigParseError &&
      error.code === "UNSUPPORTED_VERSION" &&
      error.receivedVersion === 4,
  );
  assert.throws(
    () => parseEnvironmentGatewayConfig({ version: 3 }),
    (error) =>
      error instanceof EnvironmentGatewayConfigParseError &&
      error.code === "INVALID_CONFIG",
  );
});
