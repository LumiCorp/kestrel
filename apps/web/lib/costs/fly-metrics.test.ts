import assert from "node:assert/strict";
import test from "node:test";
import "../../scripts/register-server-only.mjs";
import {
  flyPublicEgressService,
  queryFlyPublicEgressHour,
} from "./fly-metrics";

test("Fly metrics use the documented Prometheus query boundary", async () => {
  let requestedUrl = "";
  let requestedBody = "";
  const rows = await queryFlyPublicEgressHour({
    endedAt: new Date("2026-07-22T12:00:00Z"),
    env: {
      ...process.env,
      FLY_API_TOKEN: "token",
      KESTREL_FLY_ORGANIZATION_SLUG: "kestrel-test",
    },
    fetchImpl: (async (url, init) => {
      requestedUrl = String(url);
      requestedBody = String(init?.body);
      return Response.json({
        status: "success",
        data: {
          resultType: "vector",
          result: [{
            metric: { app: "kestrel-env-one", region: "iad" },
            value: [1_753_185_600, "1250000000"],
          }],
        },
      });
    }) as typeof fetch,
  });
  assert.match(requestedUrl, /api\.fly\.io\/prometheus\/kestrel-test\/api\/v1\/query/u);
  assert.match(requestedBody, /fly_edge_data_out/u);
  assert.deepEqual(rows, [{
    appName: "kestrel-env-one",
    region: "iad",
    bytes: 1_250_000_000,
  }]);
});

test("Fly egress regions select the published price groups explicitly", () => {
  assert.equal(flyPublicEgressService("iad"), "network.public_egress.na_eu");
  assert.equal(
    flyPublicEgressService("sin"),
    "network.public_egress.apac_oceania_sa"
  );
  assert.equal(
    flyPublicEgressService("jnb"),
    "network.public_egress.africa_india"
  );
  assert.equal(flyPublicEgressService("unknown"), "network.public_egress.unknown");
});
