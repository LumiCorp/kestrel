import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentGatewayConfigClient } from "../src/gateway-config.js";

function client(payload: unknown) {
  return new EnvironmentGatewayConfigClient({
    controlPlaneUrl: "http://127.0.0.1:18081",
    environmentId: "environment-test",
    serviceToken: "service-token",
    fetchImpl: (async (_request, init) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer service-token",
      );
      return Response.json(payload);
    }) as unknown as typeof fetch,
  });
}

test("gateway client reports ready after loading a v3 configuration", async () => {
  const gateway = client({
    version: 3,
    environmentId: "environment-test",
    revision: "revision-test",
    workspaces: [],
    previews: [],
    modelGrants: [],
    appGrants: [],
  });
  await gateway.refresh();
  assert.deepEqual(gateway.health, {
    ready: true,
    acceptedVersions: [2, 3, 4],
    activeVersion: 3,
    revision: "revision-test",
    gatewayId: null,
    routeGeneration: null,
    lastFailure: null,
  });
});

test("gateway client sanitizes unsupported configuration failures", async () => {
  const gateway = client({
    version: 5,
    environmentId: "environment-test",
  });
  await assert.rejects(gateway.refresh());
  assert.equal(gateway.health.ready, false);
  assert.equal(gateway.health.lastFailure?.code, "UNSUPPORTED_VERSION");
  assert.equal(gateway.health.lastFailure?.receivedVersion, 5);
  assert.deepEqual(Object.keys(gateway.health.lastFailure ?? {}).sort(), [
    "code",
    "occurredAt",
    "receivedVersion",
  ]);
});

test("gateway client activates v4 atomically and retains the last valid snapshot", async () => {
  const valid = {
    version: 4,
    environmentId: "environment-test",
    gatewayId: "gateway-resource-1",
    revision: "a".repeat(64),
    routeGeneration: "b".repeat(64),
    workspaces: [],
    previews: [],
    modelGrants: [],
    appGrants: [],
  };
  let payload: unknown = valid;
  const gateway = new EnvironmentGatewayConfigClient({
    controlPlaneUrl: "http://127.0.0.1:18081",
    environmentId: "environment-test",
    serviceToken: "service-token",
    fetchImpl: (async () => Response.json(payload)) as typeof fetch,
  });
  await gateway.refresh();
  assert.deepEqual(gateway.snapshot, valid);
  const active = gateway.snapshot;
  payload = { ...valid, revision: "broken", workspaces: [{ id: "invalid" }] };
  await assert.rejects(gateway.refresh());
  assert.equal(gateway.snapshot, active);
  assert.equal(gateway.health.revision, "a".repeat(64));
  assert.equal(gateway.health.routeGeneration, "b".repeat(64));
  assert.equal(gateway.health.lastFailure?.code, "INVALID_CONFIG");
});
