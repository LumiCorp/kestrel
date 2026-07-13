import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { proxyWorkspaceRequest } from "../src/proxy.js";

test("Environment gateway streams authorized HTTP requests to the private Workspace", async () => {
  let receivedBody = "";
  let receivedAuthorization = "";
  const workspace = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    receivedBody = Buffer.concat(chunks).toString("utf8");
    receivedAuthorization = request.headers.authorization ?? "";
    response.writeHead(201, {
      "content-type": "application/json",
      "x-workspace-proof": "private-gateway",
    });
    response.write('{"ok":');
    response.end("true}");
  });
  const workspaceUrl = await listen(workspace);
  const gateway = createServer((request, response) =>
    proxyWorkspaceRequest({ request, response, targetUrl: workspaceUrl })
  );
  const gatewayUrl = await listen(gateway);
  try {
    const response = await fetch(new URL("/v1/proof", gatewayUrl), {
      method: "POST",
      headers: {
        authorization: "Bearer signed-ticket",
        "content-type": "text/plain",
      },
      body: "gateway-body",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-workspace-proof"), "private-gateway");
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(receivedBody, "gateway-body");
    assert.equal(receivedAuthorization, "Bearer signed-ticket");
  } finally {
    await Promise.all([close(gateway), close(workspace)]);
  }
});

test("Environment gateway reports a bounded error when the Workspace is unavailable", async () => {
  const unavailable = createServer();
  const unavailableUrl = await listen(unavailable);
  await close(unavailable);
  const gateway = createServer((request, response) =>
    proxyWorkspaceRequest({ request, response, targetUrl: unavailableUrl })
  );
  const gatewayUrl = await listen(gateway);
  try {
    const response = await fetch(new URL("/v1/tree", gatewayUrl));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: { code: "ENVIRONMENT_WORKSPACE_UNAVAILABLE" },
    });
  } finally {
    await close(gateway);
  }
});

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.close();
  await once(server, "close");
}
