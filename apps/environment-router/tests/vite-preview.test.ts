import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  PREVIEW_EDGE_AUTHORIZATION_HEADER,
  PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
  PREVIEW_EDGE_ROUTE_TICKET_VERSION,
  PREVIEW_RELAY_TICKET_AUDIENCE,
  PREVIEW_RELAY_TICKET_VERSION,
  signPreviewEdgeRouteTicket,
  signPreviewRelayTicket,
} from "@lumi/kestrel-environment-auth";
import {
  handlePreviewRelayHttp,
  handlePreviewRelayUpgrade,
} from "../../workspace-runtime/src/preview-relay.js";
import { PreviewRelay } from "../src/preview-relay.js";

test("a real Vite app serves documents and HMR WebSockets through the preview relay", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "kestrel-vite-preview-"));
  const vitePort = await availablePort();
  await Promise.all([
    writeFile(
      join(projectRoot, "index.html"),
      '<!doctype html><html><body><div id="preview-proof">vite-preview-proof</div><script type="module" src="/src.js"></script></body></html>'
    ),
    writeFile(join(projectRoot, "src.js"), 'document.body.dataset.ready = "true";\n'),
  ]);
  const vite = spawn(
    "../desktop/node_modules/.bin/vite",
    [
      projectRoot,
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
  );
  let viteOutput = "";
  vite.stdout.on("data", (chunk) => { viteOutput += chunk.toString(); });
  vite.stderr.on("data", (chunk) => { viteOutput += chunk.toString(); });

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const scope = {
    organizationId: randomUUID(),
    environmentId: randomUUID(),
    workspaceId: randomUUID(),
    machineId: "machine-vite",
  };
  const previewId = randomUUID();
  const hostname = "p-vite.previews.example.test";
  const now = Math.floor(Date.now() / 1000);
  const relayTicket = signPreviewRelayTicket({
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ticket: {
      version: PREVIEW_RELAY_TICKET_VERSION,
      audience: PREVIEW_RELAY_TICKET_AUDIENCE,
      organizationId: scope.organizationId,
      environmentId: scope.environmentId,
      workspaceId: scope.workspaceId,
      flyAppName: "kestrel-env-vite",
      flyMachineId: scope.machineId,
      previewId,
      hostname,
      port: vitePort,
      issuedAt: now,
      expiresAt: now + 120,
      nonce: randomUUID(),
    },
  });
  const edgeAuthorization = `Bearer ${signPreviewEdgeRouteTicket({
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ticket: {
      version: PREVIEW_EDGE_ROUTE_TICKET_VERSION,
      audience: PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
      organizationId: scope.organizationId,
      environmentId: scope.environmentId,
      workspaceId: scope.workspaceId,
      flyAppName: "kestrel-env-vite",
      previewId,
      hostname,
      issuedAt: now,
      expiresAt: now + 120,
      nonce: randomUUID(),
    },
  })}`;
  const relayScope = {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    ...scope,
  };
  const relay = createServer((request, response) => {
    void handlePreviewRelayHttp({ request, response, scope: relayScope });
  });
  relay.on("upgrade", (request, socket, head) => {
    handlePreviewRelayUpgrade({ request, socket, head, scope: relayScope });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");

  let gateway!: PreviewRelay;
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
  gateway = new PreviewRelay({
    expectedAppName: "kestrel-env-vite",
    environmentId: scope.environmentId,
    ticketPublicKey: relayScope.publicKey,
    workspaceAddress: () => ({ host: "127.0.0.1", port: relayAddress.port }),
  });

  try {
    await waitForVite(vitePort, () => viteOutput);
    await gateway.reconcile({
      version: 3,
      environmentId: scope.environmentId,
      revision: "vite",
      workspaces: [{
        id: scope.workspaceId,
        machineId: scope.machineId,
        serviceTokenHash: "A".repeat(43),
      }],
      modelGrants: [],
      appGrants: [],
      previews: [{
        id: previewId,
        workspaceId: scope.workspaceId,
        machineId: scope.machineId,
        hostname,
        port: vitePort,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        relayTicket,
      }],
    });
    const document = await requestHost(publicAddress.port, hostname, "/", {
      [PREVIEW_EDGE_AUTHORIZATION_HEADER]: edgeAuthorization,
    });
    assert.equal(document.status, 200);
    assert.match(document.body, /vite-preview-proof/u);

    const client = connect(publicAddress.port, "127.0.0.1");
    await once(client, "connect");
    client.write([
      "GET / HTTP/1.1",
      `Host: ${hostname}`,
      `${PREVIEW_EDGE_AUTHORIZATION_HEADER}: ${edgeAuthorization}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Protocol: vite-hmr",
      "",
      "",
    ].join("\r\n"));
    const [upgrade] = (await once(client, "data")) as [Buffer];
    assert.match(upgrade.toString("utf8"), /^HTTP\/1\.1 101 Switching Protocols/u);
    client.destroy();
  } finally {
    await gateway.close();
    await Promise.all([closeServer(publicServer), closeServer(relay)]);
    vite.kill("SIGTERM");
    if (vite.exitCode === null) await once(vite, "exit").catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  return address.port;
}

async function closeServer(server: ReturnType<typeof createServer>) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function waitForVite(port: number, output: () => string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${output()}`);
}

function requestHost(
  port: number,
  host: string,
  path: string,
  headers: Record<string, string>,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers: { host, ...headers } }, (response) => {
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
