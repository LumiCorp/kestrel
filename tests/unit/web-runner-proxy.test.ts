import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { createWebRunnerProxyServer } from "../../cli/webRunnerProxy.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.process", "web runner proxy maps paths and translates only the public auth token", async (t) => {
  const upstream = await startUnixUpstream(t, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      path: request.url,
      authorization: request.headers.authorization ?? null,
      privateTokenHeader: request.headers["x-core-token"] ?? null,
    }));
  });
  const proxy = await createWebRunnerProxyServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "public-token",
    localCoreSocketPath: upstream.socketPath,
    localCoreAuthToken: "core-private-token",
  });
  t.after(async () => {
    await proxy.close();
  });

  const authenticated = await fetch(`${proxy.url}/commands?cursor=next`, {
    method: "POST",
    headers: {
      authorization: "Bearer public-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "runner.ping" }),
  });
  assert.deepEqual(await authenticated.json(), {
    path: "/runtime/v2/commands?cursor=next",
    authorization: "Bearer core-private-token",
    privateTokenHeader: null,
  });

  const coreCredentialAttempt = await fetch(`${proxy.url}/commands`, {
    method: "POST",
    headers: { authorization: "Bearer core-private-token" },
  });
  assert.deepEqual(await coreCredentialAttempt.json(), {
    path: "/runtime/v2/commands",
    authorization: null,
    privateTokenHeader: null,
  });
});

contractTest("runtime.process", "web runner proxy streams SSE response chunks without buffering", async (t) => {
  let releaseCompletion: (() => void) | undefined;
  const upstream = await startUnixUpstream(t, (_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.write("event: run.started\ndata: {\"runId\":\"run-1\"}\n\n");
    releaseCompletion = () => {
      response.end("event: run.completed\ndata: {\"runId\":\"run-1\"}\n\n");
    };
  });
  const proxy = await createWebRunnerProxyServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "public-token",
    localCoreSocketPath: upstream.socketPath,
    localCoreAuthToken: "core-private-token",
  });
  t.after(async () => {
    releaseCompletion?.();
    await proxy.close();
  });

  const response = await fetch(`${proxy.url}/commands/stream`, {
    method: "POST",
    headers: { authorization: "Bearer public-token" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
  const reader = response.body?.getReader();
  assert.notEqual(reader, undefined);
  const first = await reader!.read();
  assert.equal(first.done, false);
  assert.match(Buffer.from(first.value).toString("utf8"), /event: run\.started/u);

  releaseCompletion?.();
  const remaining: Buffer[] = [];
  while (true) {
    const next = await reader!.read();
    if (next.done) {
      break;
    }
    remaining.push(Buffer.from(next.value));
  }
  assert.match(Buffer.concat(remaining).toString("utf8"), /event: run\.completed/u);
});

async function startUnixUpstream(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ socketPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kestrel-web-proxy-"));
  const socketPath = path.join(directory, "core.sock");
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
      server.closeAllConnections?.();
    });
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath };
}
