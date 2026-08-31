import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";

import { handleBrowserDownload } from "../src/browser-download.js";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

test("Browser download preparation and bytes remain exact-body-bound dedicated Router traffic", async () => {
  const prepareEnvelope = {
    ...scope(),
    version: "hosted_browser_download_prepare_router_envelope_v1",
    request: { version: "browser_download_preparation_v1" },
    capability: "signed-preparation-capability",
  };
  const prepareBody = Buffer.from(JSON.stringify(prepareEnvelope));
  const prepared = responseCapture();
  await handleBrowserDownload({
    request: incoming(prepareBody, credential(prepareBody, "browser.download.prepare")),
    response: prepared.response,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async (url, init) => {
      assert.equal(String(url), "http://machine-1.vm.environment-app.internal:43105/v1/download/prepare");
      assert.equal(Buffer.from(init?.body as Buffer).toString("utf8"), prepareBody.toString("utf8"));
      return new Response(JSON.stringify({ prepared: true }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(prepared.status, 200);
  assert.deepEqual(JSON.parse(prepared.body.toString("utf8")), { prepared: true });

  const bytes = Buffer.from("exact quarantined bytes");
  const bytesEnvelope = {
    ...scope(),
    version: "hosted_browser_download_bytes_router_envelope_v1",
    operationId: "call-download-1",
    capability: "signed-operation-capability",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const bytesBody = Buffer.from(JSON.stringify(bytesEnvelope));
  const streamed = responseCapture();
  await handleBrowserDownload({
    request: incoming(bytesBody, credential(bytesBody, "browser.download.bytes")),
    response: streamed.response,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async (url, init) => {
      assert.equal(String(url), "http://machine-1.vm.environment-app.internal:43105/v1/download/bytes");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-kestrel-browser-operation-id"), "call-download-1");
      assert.equal(headers.get("x-kestrel-browser-operation-capability"), "signed-operation-capability");
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-length": String(bytes.byteLength),
          "x-kestrel-browser-download-sha256": bytesEnvelope.sha256,
        },
      });
    }) as typeof fetch,
  });
  assert.equal(streamed.status, 200);
  assert.deepEqual(streamed.body, bytes);

  const releaseEnvelope = {
    ...scope(),
    version: "hosted_browser_download_release_router_envelope_v1",
    operationId: "call-download-1",
    capability: "signed-release-capability",
    effect: { version: "browser_download_preparation_v1", pendingDownloadId: "download-1" },
  };
  const releaseBody = Buffer.from(JSON.stringify(releaseEnvelope));
  const released = responseCapture();
  await handleBrowserDownload({
    request: incoming(releaseBody, credential(releaseBody, "browser.download.release")),
    response: released.response,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async (url, init) => {
      assert.equal(String(url), "http://machine-1.vm.environment-app.internal:43105/v1/download/release");
      assert.equal(Buffer.from(init?.body as Buffer).toString("utf8"), releaseBody.toString("utf8"));
      return Response.json({ released: true, operationId: "call-download-1" });
    }) as typeof fetch,
  });
  assert.equal(released.status, 200);
});

test("Browser download Router rejects changed scope and one byte over the canonical file limit", async () => {
  const envelope = {
    ...scope(),
    version: "hosted_browser_download_bytes_router_envelope_v1",
    operationId: "call-download-1",
    capability: "signed-operation-capability",
    sizeBytes: 1,
    sha256: "a".repeat(64),
  };
  const body = Buffer.from(JSON.stringify(envelope));
  const changed = Buffer.from(JSON.stringify({ ...envelope, threadId: "thread-other" }));
  const denied = responseCapture();
  let workerCalls = 0;
  await handleBrowserDownload({
    request: incoming(changed, credential(body, "browser.download.bytes")),
    response: denied.response,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async () => { workerCalls += 1; return new Response(); }) as typeof fetch,
  });
  assert.equal(denied.status, 403);

  const oversized = responseCapture();
  await handleBrowserDownload({
    request: incoming(body, credential(body, "browser.download.bytes")),
    response: oversized.response,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async () => {
      workerCalls += 1;
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": String(100 * 1024 * 1024 + 1),
          "x-kestrel-browser-download-sha256": envelope.sha256,
        },
      });
    }) as typeof fetch,
  });
  assert.equal(oversized.status, 403);
  assert.equal(workerCalls, 1);
});

function scope() {
  return {
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    userId: "user-1",
    threadId: "thread-1",
    runId: "run-1",
    sessionId: "browser-session-1",
    machine: { appName: "environment-app", machineId: "machine-1" },
  };
}

function credential(bindingBytes: Buffer, operation: string) {
  const now = Math.floor(Date.now() / 1000);
  return signEnvironmentToolCredential({
    privateKey,
    ticket: {
      version: ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
      audience: ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
      organizationId: "org-1",
      environmentId: "env-1",
      workspaceId: "browser:browser-session-1",
      threadId: "thread-1",
      runId: "run-1",
      actorId: "user-1",
      agentId: "kestrel-control-plane",
      providerKey: "built_in.browser",
      resourceId: "browser-session-1",
      capability: operation,
      operation,
      operationBinding: `sha256:${createHash("sha256").update(bindingBytes).digest("base64url")}`,
      issuedAt: now,
      expiresAt: now + 60,
      nonce: `download-${operation}`,
    },
  });
}

function incoming(body: Buffer, token: string) {
  const request = Readable.from([body]) as unknown as IncomingMessage;
  request.headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return request;
}

function responseCapture() {
  let status = 0;
  const chunks: Buffer[] = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  }) as unknown as ServerResponse;
  response.writeHead = ((nextStatus: number) => {
    status = nextStatus;
    return response;
  }) as ServerResponse["writeHead"];
  return {
    response,
    get status() { return status; },
    get body() { return Buffer.concat(chunks); },
  };
}
