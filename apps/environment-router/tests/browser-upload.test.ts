import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";

import { handleBrowserUpload } from "../src/browser-upload.js";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

test("Browser upload bytes use a dedicated body-bound Router stream", async () => {
  const bytes = Buffer.from("approved attachment");
  const envelope = bytesEnvelope(bytes);
  const encodedEnvelope = Buffer.from(JSON.stringify(envelope)).toString("base64url");
  const request = incoming(bytes, credential(Buffer.from(JSON.stringify(envelope)), "browser.upload.bytes"), {
    "content-type": "application/octet-stream",
    "content-length": String(bytes.byteLength),
    "x-kestrel-browser-upload-envelope": encodedEnvelope,
  });
  const capture = responseCapture();
  let forwarded = Buffer.alloc(0);
  await handleBrowserUpload({
    request,
    response: capture.response,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    prepare: false,
    fetchImpl: (async (url, init) => {
      assert.equal(
        String(url),
        "http://machine-1.vm.environment-app.internal:43105/v1/upload/bytes",
      );
      assert.equal(new Headers(init?.headers).get("content-length"), String(bytes.byteLength));
      assert.equal(new Headers(init?.headers).get("x-kestrel-browser-operation-id"), "call-upload-1");
      const chunks: Buffer[] = [];
      for await (const chunk of init?.body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      forwarded = Buffer.concat(chunks);
      return new Response(JSON.stringify({ staged: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assert.equal(capture.status, 200);
  assert.deepEqual(forwarded, bytes);
  assert.deepEqual(JSON.parse(capture.body), { staged: true });
});

test("Browser upload preparation is exact-body bound and oversized bytes never reach the worker", async () => {
  const prepareEnvelope = {
    ...scope(),
    version: "hosted_browser_upload_prepare_router_envelope_v1",
    request: { version: "browser_upload_preparation_v1" },
    capability: "signed-preparation-capability",
  };
  const body = Buffer.from(JSON.stringify(prepareEnvelope));
  const valid = responseCapture();
  let calls = 0;
  await handleBrowserUpload({
    request: incoming(body, credential(body, "browser.upload.prepare")),
    response: valid.response,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    prepare: true,
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ prepared: true }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(valid.status, 200);

  const changed = Buffer.from(body.toString("utf8").replace("signed-preparation-capability", "changed-capability"));
  const denied = responseCapture();
  await handleBrowserUpload({
    request: incoming(changed, credential(body, "browser.upload.prepare")),
    response: denied.response,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    prepare: true,
    fetchImpl: (async () => {
      calls += 1;
      return new Response();
    }) as typeof fetch,
  });
  assert.equal(denied.status, 403);

  const uploadEnvelope = bytesEnvelope(Buffer.alloc(0));
  const uploadEnvelopeBytes = Buffer.from(JSON.stringify(uploadEnvelope));
  const oversized = responseCapture();
  await handleBrowserUpload({
    request: incoming(Buffer.alloc(0), credential(uploadEnvelopeBytes, "browser.upload.bytes"), {
      "content-length": String(100 * 1024 * 1024 + 1),
      "x-kestrel-browser-upload-envelope": uploadEnvelopeBytes.toString("base64url"),
    }),
    response: oversized.response,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    prepare: false,
    fetchImpl: (async () => {
      calls += 1;
      return new Response();
    }) as typeof fetch,
  });
  assert.equal(oversized.status, 403);
  assert.equal(calls, 1);
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

function bytesEnvelope(bytes: Buffer) {
  return {
    ...scope(),
    version: "hosted_browser_upload_bytes_router_envelope_v1",
    operationId: "call-upload-1",
    capability: "signed-operation-capability",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
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
      nonce: `upload-${operation}`,
    },
  });
}

function incoming(body: Buffer, token: string, headers: Record<string, string> = {}) {
  const request = Readable.from([body]) as unknown as IncomingMessage;
  request.headers = { authorization: `Bearer ${token}`, ...headers };
  return request;
}

function responseCapture() {
  let status = 0;
  let body = "";
  const response = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    end(value?: string | Buffer) {
      body = value === undefined ? "" : Buffer.from(value).toString("utf8");
      return this;
    },
  } as unknown as ServerResponse;
  return {
    response,
    get status() { return status; },
    get body() { return body; },
  };
}
