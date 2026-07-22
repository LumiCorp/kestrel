import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { connect } from "node:net";
import { ENVIRONMENT_GATEWAY_CONFIG_VERSION, type EnvironmentGatewayConfig } from "@lumi/kestrel-environment-auth";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import { EnvironmentGatewayConfigClient } from "../src/gateway-config.js";
import { PreviewGateway } from "../src/preview-gateway.js";

contractTest("services.process", "preview gateway binds one wildcard endpoint and routes only exact configured hosts", async () => {
  const observed: Array<{ url: string | undefined; authorization: string | undefined; forwardedHost: string | undefined }> = [];
  const observedUpgrades: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  const workspace = createServer((request, response) => {
    observed.push({
      url: request.url,
      authorization: request.headers.authorization,
      forwardedHost: request.headers["x-forwarded-host"] as string | undefined,
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: ready\n\n");
  });
  workspace.on("upgrade", (request, socket) => {
    observedUpgrades.push({ url: request.url, authorization: request.headers.authorization });
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  workspace.listen(0, "127.0.0.1");
  await once(workspace, "listening");
  const workspaceAddress = workspace.address();
  assert.ok(workspaceAddress && typeof workspaceAddress !== "string");
  const opened: Array<{ wildcardDomain: string; targetUrl: string }> = [];
  let closed = 0;
  const gateway = new PreviewGateway({
    port: 8080,
    expectedAppName: "kestrel-env-1",
    environmentId: "environment-1",
    workspaceAddress: () => ({ host: "127.0.0.1", port: workspaceAddress.port }),
    openEndpoint: async ({ wildcardDomain, targetUrl }) => {
      opened.push({ wildcardDomain, targetUrl });
      return { close: async () => { closed += 1; } };
    },
  });
  const config: EnvironmentGatewayConfig = {
    version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
    environmentId: "environment-1",
    revision: "one",
    ngrok: {
      connectionId: "connection-1",
      authtoken: "ngrok-secret",
      wildcardDomain: "*.previews.example.com",
    },
    workspaces: [],
    modelGrants: [],
    previews: [{
      id: "preview-1",
      workspaceId: "workspace-1",
      machineId: "machine-1",
      hostname: "p-one.previews.example.com",
      port: 5173,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      relayTicket: "signed-relay-ticket",
    }],
  };
  await gateway.reconcile(config);
  await gateway.reconcile({ ...config, revision: "two" });
  assert.deepEqual(opened, [{
    wildcardDomain: "*.previews.example.com",
    targetUrl: "http://127.0.0.1:8080",
  }]);

  const publicServer = createServer(async (request, response) => {
    if (!(await gateway.handleHttp(request, response))) response.writeHead(404).end();
  });
  publicServer.on("upgrade", (request, socket, head) => {
    if (!gateway.handleUpgrade(request, socket, head)) socket.destroy();
  });
  publicServer.listen(0, "127.0.0.1");
  await once(publicServer, "listening");
  const publicAddress = publicServer.address();
  assert.ok(publicAddress && typeof publicAddress !== "string");
  try {
    const response = await requestHost(publicAddress.port, "p-one.previews.example.com", "/assets/main.js");
    assert.equal(response.status, 200);
    assert.equal(response.body, "data: ready\n\n");
    assert.deepEqual(observed, [{
      url: "/v1/preview-relay/preview-1/assets/main.js",
      authorization: "Bearer signed-relay-ticket",
      forwardedHost: "p-one.previews.example.com",
    }]);
    const unknown = await requestHost(publicAddress.port, "not-configured.previews.example.com", "/");
    assert.equal(unknown.status, 404);

    const client = connect(publicAddress.port, "127.0.0.1");
    await once(client, "connect");
    client.write([
      "GET /@vite/client HTTP/1.1",
      "Host: p-one.previews.example.com",
      "Authorization: Bearer public-client-value",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: dGVzdA==",
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"));
    const [upgrade] = await once(client, "data") as [Buffer];
    assert.match(upgrade.toString("utf8"), /^HTTP\/1\.1 101 Switching Protocols/u);
    client.destroy();
    assert.deepEqual(observedUpgrades, [{
      url: "/v1/preview-relay/preview-1/@vite/client",
      authorization: "Bearer signed-relay-ticket",
    }]);

    await gateway.reconcile({ ...config, revision: "three", previews: [] });
    assert.equal(closed, 0);
    await gateway.reconcile({ ...config, revision: "four", ngrok: null, previews: [] });
    assert.equal(closed, 1);
  } finally {
    await gateway.close();
    publicServer.close();
    workspace.close();
  }
});

contractTest("services.process", "preview gateway retries reconciliation after an endpoint failure", async () => {
  let attempts = 0;
  const gateway = new PreviewGateway({
    port: 8080,
    expectedAppName: "kestrel-env-1",
    environmentId: "environment-1",
    openEndpoint: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary ngrok failure");
      return { close: async () => {} };
    },
  });
  const config: EnvironmentGatewayConfig = {
    version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
    environmentId: "environment-1",
    revision: "one",
    ngrok: {
      connectionId: "connection-1",
      authtoken: "ngrok-secret",
      wildcardDomain: "*.previews.example.com",
    },
    workspaces: [],
    modelGrants: [],
    previews: [],
  };

  await assert.rejects(gateway.reconcile(config), /temporary ngrok failure/u);
  assert.equal(gateway.isReady(config), false);
  await gateway.reconcile({ ...config, revision: "two" });
  assert.equal(attempts, 2);
  assert.equal(gateway.isReady(config), true);
  await gateway.close();
});

contractTest("services.process", "gateway configuration remains available when preview reconciliation fails", async () => {
  const config: EnvironmentGatewayConfig = {
    version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
    environmentId: "environment-1",
    revision: "one",
    ngrok: null,
    workspaces: [],
    modelGrants: [],
    previews: [],
  };
  const client = new EnvironmentGatewayConfigClient({
    controlPlaneUrl: "http://127.0.0.1:9999",
    environmentId: "environment-1",
    serviceToken: "gateway-secret",
    fetchImpl: async () => Response.json(config),
  });
  client.subscribe(() => {
    throw new Error("ngrok endpoint unavailable");
  });

  assert.deepEqual(await client.refresh(), config);
  assert.deepEqual(client.snapshot, config);
  client.stop();
});

contractTest("services.process", "explicit gateway refresh waits for an in-flight load and then fetches current state", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let fetchCount = 0;
  const client = new EnvironmentGatewayConfigClient({
    controlPlaneUrl: "http://127.0.0.1:9999",
    environmentId: "environment-1",
    serviceToken: "gateway-secret",
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) await firstBlocked;
      return Response.json({
        version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
        environmentId: "environment-1",
        revision: String(fetchCount),
        ngrok: null,
        workspaces: [],
        modelGrants: [],
        previews: [],
      });
    },
  });

  const background = client.refresh();
  const explicit = client.refreshLatest();
  releaseFirst();
  assert.equal((await background).revision, "1");
  assert.equal((await explicit).revision, "2");
  assert.equal(fetchCount, 2);
  client.stop();
});

function requestHost(port: number, host: string, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}
