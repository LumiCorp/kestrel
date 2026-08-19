import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  handleAppRelay,
  isAllowedAppRequest,
} from "../src/app-relay.js";
import { EnvironmentGatewayConfigClient } from "../src/gateway-config.js";

test("app relay refreshes expired execution tickets and enforces workspace and path scope", async () => {
  const observed: Array<Record<string, unknown>> = [];
  const controlPlane = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    observed.push({
      path: request.url,
      authorization: request.headers.authorization,
      approvalId: request.headers["x-kestrel-approval-id"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    if (request.headers.authorization === "Bearer stale-ticket") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "TICKET_EXPIRED" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  controlPlane.listen(0, "127.0.0.1");
  await once(controlPlane, "listening");
  const address = controlPlane.address();
  assert.ok(address && typeof address !== "string");

  const environmentId = randomUUID();
  const workspaceId = randomUUID();
  const runId = randomUUID();
  const workspaceToken = "workspace-secret";
  let refreshCount = 0;
  const config = new EnvironmentGatewayConfigClient({
    controlPlaneUrl: `http://127.0.0.1:${address.port}`,
    environmentId,
    serviceToken: "gateway-secret",
    fetchImpl: async () => {
      refreshCount += 1;
      return Response.json({
        version: 3,
        environmentId,
        revision: String(refreshCount),
        workspaces: [{
          id: workspaceId,
          machineId: "machine-1",
          serviceTokenHash: createHash("sha256")
            .update(workspaceToken)
            .digest("base64url"),
        }],
        previews: [],
        modelGrants: [],
        appGrants: [{
          executionId: runId,
          runId: "runtime-run-1",
          workspaceId,
          executionTicket: refreshCount === 1 ? "stale-ticket" : "fresh-ticket",
          credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }],
      });
    },
  });
  await config.refresh();
  const relay = createServer((request, response) => {
    void handleAppRelay({ request, response, config });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");

  try {
    const response = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/apps/${runId}/api/runtime/email/action`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${workspaceToken}`,
          "content-type": "application/json",
          "x-kestrel-approval-id": "approval-1",
        },
        body: JSON.stringify({ operation: "list" }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(refreshCount, 2);
    assert.deepEqual(observed, [
      {
        path: "/api/runtime/email/action",
        authorization: "Bearer stale-ticket",
        approvalId: "approval-1",
        body: { operation: "list" },
      },
      {
        path: "/api/runtime/email/action",
        authorization: "Bearer fresh-ticket",
        approvalId: "approval-1",
        body: { operation: "list" },
      },
    ]);

    const wrongRun = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/apps/${randomUUID()}/api/runtime/email/action`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${workspaceToken}` },
      },
    );
    assert.equal(wrongRun.status, 403);

    const deniedPath = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/apps/${runId}/api/runtime/not-allowlisted`,
      { headers: { authorization: `Bearer ${workspaceToken}` } },
    );
    assert.equal(deniedPath.status, 404);

    const arbitraryAppPath = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/apps/${runId}/api/runtime/apps/arbitrary/read/auto/data`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${workspaceToken}` },
      },
    );
    assert.equal(arbitraryAppPath.status, 404);
  } finally {
    relay.close();
    controlPlane.close();
    config.stop();
  }
});

test("app relay allowlists only supported app methods and contracts", () => {
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.previews/inspect/auto/ports/3000",
    "GET",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.previews/inspect/auto/ports/3000",
    "POST",
  ), false);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.weather/forecast/auto/timeline",
    "POST",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/tavily/research_status/auto/research/request-1",
    "GET",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/vercel/operations.read/confirmed/deployment-events",
    "POST",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/arbitrary/read/auto/data",
    "POST",
  ), false);
});
