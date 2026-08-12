import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import {
  ENVIRONMENT_GATEWAY_CONFIG_VERSION,
  type EnvironmentGatewayConfig,
  PREVIEW_EDGE_AUTHORIZATION_HEADER,
  PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
  PREVIEW_EDGE_ROUTE_TICKET_VERSION,
  signPreviewEdgeRouteTicket,
} from "@lumi/kestrel-environment-auth";
import { EnvironmentGatewayConfigClient } from "../src/gateway-config.js";
import { PreviewRelay } from "../src/preview-relay.js";

test(
  "Kestrel Edge requires an exact signed route for HTTP and WebSocket traffic",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const publicKey = keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const hostname = "p-edge.preview.kestrelagents.dev";
    const observed: Array<{
      edgeAuthorization: string | undefined;
      url: string | undefined;
    }> = [];
    const workspace = createServer((request, response) => {
      observed.push({
        edgeAuthorization: request.headers[
          PREVIEW_EDGE_AUTHORIZATION_HEADER
        ] as string | undefined,
        url: request.url,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: ready\n\n");
    });
    workspace.on("upgrade", (request, socket) => {
      observed.push({
        edgeAuthorization: request.headers[
          PREVIEW_EDGE_AUTHORIZATION_HEADER
        ] as string | undefined,
        url: request.url,
      });
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
    workspace.listen(0, "127.0.0.1");
    await once(workspace, "listening");
    const workspaceAddress = workspace.address();
    assert.ok(workspaceAddress && typeof workspaceAddress !== "string");

    const relay = new PreviewRelay({
      expectedAppName: "kestrel-env-edge",
      environmentId: "environment-edge",
      ticketPublicKey: publicKey,
      workspaceAddress: () => ({
        host: "127.0.0.1",
        port: workspaceAddress.port,
      }),
    });
    const config: EnvironmentGatewayConfig = {
      version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
      environmentId: "environment-edge",
      revision: "edge",
      workspaces: [],
      modelGrants: [],
      appGrants: [],
      previews: [
        {
          id: "preview-edge",
          workspaceId: "workspace-edge",
          machineId: "machine-edge",
          hostname,
          port: 5173,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          relayTicket: "signed-relay-ticket",
        },
      ],
    };
    await relay.reconcile(config);
    assert.equal(relay.isReady(config), true);

    const publicServer = createServer(async (request, response) => {
      if (!(await relay.handleHttp(request, response))) {
        response.writeHead(404).end();
      }
    });
    publicServer.on("upgrade", (request, socket, head) => {
      if (!relay.handleUpgrade(request, socket, head)) socket.destroy();
    });
    publicServer.listen(0, "127.0.0.1");
    await once(publicServer, "listening");
    const publicAddress = publicServer.address();
    assert.ok(publicAddress && typeof publicAddress !== "string");

    const now = Math.floor(Date.now() / 1000);
    const authorization = `Bearer ${signPreviewEdgeRouteTicket({
      privateKey,
      ticket: {
        version: PREVIEW_EDGE_ROUTE_TICKET_VERSION,
        audience: PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
        organizationId: "organization-edge",
        environmentId: "environment-edge",
        workspaceId: "workspace-edge",
        flyAppName: "kestrel-env-edge",
        previewId: "preview-edge",
        hostname,
        issuedAt: now,
        expiresAt: now + 60,
        nonce: "edge-route",
      },
    })}`;

    try {
      const denied = await requestHost(publicAddress.port, hostname, "/");
      assert.equal(denied.status, 403);

      const response = await requestHost(publicAddress.port, hostname, "/", {
        [PREVIEW_EDGE_AUTHORIZATION_HEADER]: authorization,
      });
      assert.equal(response.status, 200);
      assert.equal(response.body, "data: ready\n\n");
      assert.deepEqual(observed, [
        {
          edgeAuthorization: undefined,
          url: "/v1/preview-relay/preview-edge/",
        },
      ]);

      const client = connect(publicAddress.port, "127.0.0.1");
      await once(client, "connect");
      client.write(
        [
          "GET /@vite/client HTTP/1.1",
          `Host: ${hostname}`,
          `${PREVIEW_EDGE_AUTHORIZATION_HEADER}: ${authorization}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGVzdA==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
      const [upgrade] = (await once(client, "data")) as [Buffer];
      assert.match(
        upgrade.toString("utf8"),
        /^HTTP\/1\.1 101 Switching Protocols/u,
      );
      client.destroy();
      assert.deepEqual(observed[1], {
        edgeAuthorization: undefined,
        url: "/v1/preview-relay/preview-edge/@vite/client",
      });
    } finally {
      await relay.close();
      publicServer.close();
      workspace.close();
    }
  },
);

test(
  "gateway configuration v3 accepts v2 during rollout and rejects retired provider fields",
  async () => {
    const baseConfig = {
      version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
      environmentId: "environment-1",
      revision: "edge-only",
      workspaces: [
        {
          id: "workspace-1",
          machineId: "machine-1",
          serviceTokenHash: "a".repeat(43),
        },
      ],
      modelGrants: [],
      appGrants: [],
      previews: [
        {
          id: "preview-1",
          workspaceId: "workspace-1",
          machineId: "machine-1",
          hostname: "p-edge.preview.kestrelagents.dev",
          port: 5173,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          relayTicket: "signed-relay-ticket",
        },
      ],
    };
    const client = clientFor(baseConfig);
    assert.deepEqual(await client.refresh(), baseConfig);
    client.stop();

    const { appGrants: _appGrants, ...versionTwoFields } = baseConfig;
    const versionTwoClient = clientFor({ ...versionTwoFields, version: 2 });
    assert.deepEqual(await versionTwoClient.refresh(), baseConfig);
    versionTwoClient.stop();

    const retiredProviderField = ["n", "g", "r", "o", "k"].join("");
    for (const [label, invalid] of [
      ["version 1", { ...baseConfig, version: 1 }],
      [
        "retired provider block",
        { ...baseConfig, [retiredProviderField]: null },
      ],
      [
        "per-route ingress",
        {
          ...baseConfig,
          previews: [{ ...baseConfig.previews[0], ingress: "kestrel_edge" }],
        },
      ],
    ]) {
      const invalidClient = clientFor(invalid);
      await assert.rejects(
        invalidClient.refresh(),
        /gateway configuration is invalid/u,
        label,
      );
      invalidClient.stop();
    }
  },
);

test(
  "gateway configuration remains available when a relay listener fails",
  async () => {
    const config: EnvironmentGatewayConfig = {
      version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
      environmentId: "environment-1",
      revision: "one",
      workspaces: [],
      modelGrants: [],
      appGrants: [],
      previews: [],
    };
    const client = clientFor(config);
    client.subscribe(() => {
      throw new Error("preview relay unavailable");
    });

    assert.deepEqual(await client.refresh(), config);
    assert.deepEqual(client.snapshot, config);
    client.stop();
  },
);

test(
  "explicit gateway refresh waits for an in-flight load and fetches current state",
  async () => {
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
          workspaces: [],
          modelGrants: [],
          appGrants: [],
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
  },
);

function clientFor(config: unknown) {
  return new EnvironmentGatewayConfigClient({
    controlPlaneUrl: "http://127.0.0.1:9999",
    environmentId: "environment-1",
    serviceToken: "gateway-secret",
    fetchImpl: async () => Response.json(config),
  });
}

function requestHost(
  port: number,
  host: string,
  path: string,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host, ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}
