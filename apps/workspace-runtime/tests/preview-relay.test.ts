import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import {
  PREVIEW_RELAY_TICKET_AUDIENCE,
  PREVIEW_RELAY_TICKET_VERSION,
  signPreviewRelayTicket,
} from "@lumi/kestrel-environment-auth";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import { handlePreviewRelayHttp, handlePreviewRelayUpgrade } from "../src/preview-relay.js";

contractTest("services.process", "preview relay authenticates its exact workspace and streams without exposing the ticket", async () => {
  const observed: Array<{ url: string | undefined; authorization: string | undefined; host: string | undefined; forwardedHost: string | undefined }> = [];
  const application = createServer((request, response) => {
    observed.push({
      url: request.url,
      authorization: request.headers.authorization,
      host: request.headers.host,
      forwardedHost: request.headers["x-forwarded-host"] as string | undefined,
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: one\n\n");
    response.end("data: two\n\n");
  });
  application.listen(0, "127.0.0.1");
  await once(application, "listening");
  const applicationAddress = application.address();
  assert.ok(applicationAddress && typeof applicationAddress !== "string");

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const scope = {
    organizationId: randomUUID(),
    environmentId: randomUUID(),
    workspaceId: randomUUID(),
    machineId: "machine-1",
  };
  const previewId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const token = signPreviewRelayTicket({
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ticket: {
      version: PREVIEW_RELAY_TICKET_VERSION,
      audience: PREVIEW_RELAY_TICKET_AUDIENCE,
      ...scope,
      flyAppName: "kestrel-env-1",
      flyMachineId: scope.machineId,
      previewId,
      hostname: "p-secret.previews.example.com",
      port: applicationAddress.port,
      issuedAt: now,
      expiresAt: now + 120,
      nonce: randomUUID(),
    },
  });
  const relayScope = {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    ...scope,
  };
  const relay = createServer((request, response) => {
    void handlePreviewRelayHttp({ request, response, scope: relayScope });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");

  try {
    const response = await fetch(
      `http://127.0.0.1:${relayAddress.port}/v1/preview-relay/${previewId}/events?cursor=7`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "data: one\n\ndata: two\n\n");
    assert.deepEqual(observed, [{
      url: "/events?cursor=7",
      authorization: undefined,
      host: `127.0.0.1:${applicationAddress.port}`,
      forwardedHost: "p-secret.previews.example.com",
    }]);

    const denied = await fetch(
      `http://127.0.0.1:${relayAddress.port}/v1/preview-relay/${randomUUID()}/`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    assert.equal(denied.status, 403);
  } finally {
    relay.close();
    application.close();
  }
});

contractTest("services.process", "preview relay carries WebSocket upgrades to the selected loopback port", async () => {
  let observedAuthorization: string | undefined;
  const application = createServer();
  application.on("upgrade", (request, socket) => {
    observedAuthorization = request.headers.authorization;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
    );
    socket.pipe(socket);
  });
  application.listen(0, "127.0.0.1");
  await once(application, "listening");
  const applicationAddress = application.address();
  assert.ok(applicationAddress && typeof applicationAddress !== "string");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const scope = {
    organizationId: randomUUID(),
    environmentId: randomUUID(),
    workspaceId: randomUUID(),
    machineId: "machine-ws",
  };
  const previewId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const token = signPreviewRelayTicket({
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ticket: {
      version: PREVIEW_RELAY_TICKET_VERSION,
      audience: PREVIEW_RELAY_TICKET_AUDIENCE,
      ...scope,
      flyAppName: "kestrel-env-ws",
      flyMachineId: scope.machineId,
      previewId,
      hostname: "p-ws.previews.example.com",
      port: applicationAddress.port,
      issuedAt: now,
      expiresAt: now + 120,
      nonce: randomUUID(),
    },
  });
  const relayScope = {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    ...scope,
  };
  const relay = createServer();
  relay.on("upgrade", (request, socket, head) => {
    handlePreviewRelayUpgrade({ request, socket, head, scope: relayScope });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");
  const client = connect(relayAddress.port, "127.0.0.1");
  await once(client, "connect");
  try {
    client.write([
      `GET /v1/preview-relay/${previewId}/socket HTTP/1.1`,
      `Host: 127.0.0.1:${relayAddress.port}`,
      `Authorization: Bearer ${token}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: dGVzdA==",
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"));
    const [chunk] = await once(client, "data") as [Buffer];
    assert.match(chunk.toString("utf8"), /^HTTP\/1\.1 101 Switching Protocols/u);
    assert.equal(observedAuthorization, undefined);
  } finally {
    client.destroy();
    relay.close();
    application.close();
  }
});
