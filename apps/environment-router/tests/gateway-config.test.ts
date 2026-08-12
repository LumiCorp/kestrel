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
    acceptedVersions: [2, 3],
    activeVersion: 3,
    lastFailure: null,
  });
});

test("gateway client sanitizes unsupported configuration failures", async () => {
  const gateway = client({
    version: 4,
    environmentId: "environment-test",
  });
  await assert.rejects(gateway.refresh());
  assert.equal(gateway.health.ready, false);
  assert.equal(gateway.health.lastFailure?.code, "UNSUPPORTED_VERSION");
  assert.equal(gateway.health.lastFailure?.receivedVersion, 4);
  assert.deepEqual(Object.keys(gateway.health.lastFailure ?? {}).sort(), [
    "code",
    "occurredAt",
    "receivedVersion",
  ]);
});
