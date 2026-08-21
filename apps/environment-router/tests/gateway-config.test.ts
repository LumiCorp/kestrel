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

test("a timed-out gateway refresh clears single-flight state and permits recovery", async () => {
  const payload = {
    version: 3,
    environmentId: "environment-test",
    revision: "recovered",
    workspaces: [],
    previews: [],
    modelGrants: [],
    appGrants: [],
  };
  let requests = 0;
  const gateway = new EnvironmentGatewayConfigClient({
    controlPlaneUrl: "http://127.0.0.1:18081",
    environmentId: "environment-test",
    serviceToken: "service-token",
    requestTimeoutMs: 5,
    fetchImpl: (async () => {
      requests += 1;
      if (requests === 1) return new Promise<Response>(() => {});
      return Response.json(payload);
    }) as typeof fetch,
  });

  const first = gateway.refresh();
  assert.equal(gateway.refresh(), first);
  await assert.rejects(first, /timed out/u);
  assert.equal(gateway.health.lastFailure?.code, "UNAVAILABLE");

  assert.deepEqual(await gateway.refresh(), payload);
  assert.equal(requests, 2);
  assert.equal(gateway.snapshot?.revision, "recovered");
});
