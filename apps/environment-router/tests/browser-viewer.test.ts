import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import { issueHostedBrowserViewerTicket } from "../../../src/browser/hostedViewer.js";
import {
  authorizeBrowserViewerControl,
  handleBrowserViewerControl,
  readBoundedBrowserViewerWorkerBody,
} from "../src/browser-viewer.js";

const environmentKeys = generateKeyPairSync("ed25519");
const environmentPrivateKey = environmentKeys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const environmentPublicKey = environmentKeys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const viewerKeys = generateKeyPairSync("ed25519");
const viewerPrivateKey = viewerKeys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const viewerPublicKey = viewerKeys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

test("the Environment Router owns a dedicated Browser viewer control route", () => {
  const server = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/server.ts"),
    "utf8",
  );
  assert.match(server, /pathname === "\/internal\/browser\/viewer"/u);
  assert.match(server, /handleBrowserViewerControl/u);
  assert.doesNotMatch(server, /\/internal\/apps\/[^\n]*browser\/viewer/u);
});

function viewerRequest(input?: {
  nowSeconds?: number;
  envelopeProjectId?: string;
  ticketProjectId?: string;
  environmentId?: string;
  appName?: string;
}) {
  const issuedAt = input?.nowSeconds ?? 1000;
  const environmentId = input?.environmentId ?? "env-1";
  const viewerTicket = issueHostedBrowserViewerTicket({
    privateKeyPem: viewerPrivateKey,
    now: new Date(issuedAt * 1000),
    claims: {
      version: "hosted_browser_viewer_ticket_v1",
      audience: "kestrel-one-browser-viewer",
      organizationId: "org-1",
      environmentId,
      projectId: input?.ticketProjectId ?? "project-1",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 3,
      actorId: "user-1",
      nonce: "viewer-nonce-1",
      issuedAt: new Date(issuedAt * 1000).toISOString(),
      expiresAt: new Date((issuedAt + 60) * 1000).toISOString(),
    },
  });
  const envelope = {
    version: "hosted_browser_viewer_router_envelope_v1",
    organizationId: "org-1",
    environmentId,
    projectId: input?.envelopeProjectId ?? "project-1",
    userId: "user-1",
    threadId: "thread-1",
    runId: "run-1",
    viewerPublicKeyPem: viewerPublicKey,
    instruction: {
      version: "hosted_browser_viewer_instruction_v1",
      sessionId: "browser-session-1",
      generation: 3,
      action: "input",
      operation: "viewer.input",
      viewerTicket,
      machine: {
        appName: input?.appName ?? "environment-app",
        machineId: "machine-1",
      },
      connectionId: "connection-1",
      leaseId: "lease-1",
      viewerInput: {
        version: "desktop_browser_viewer_input_v1",
        kind: "keyboard",
        phase: "down",
        key: "x",
        text: "x",
      },
    },
  };
  const body = Buffer.from(JSON.stringify(envelope));
  const token = signEnvironmentToolCredential({
    privateKey: environmentPrivateKey,
    ticket: {
      version: ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
      audience: ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
      organizationId: "org-1",
      environmentId,
      workspaceId: "browser:browser-session-1",
      threadId: "thread-1",
      runId: "run-1",
      actorId: "user-1",
      agentId: "kestrel-control-plane",
      providerKey: "built_in.browser",
      resourceId: "browser-session-1",
      capability: "browser.viewer.control",
      operation: "viewer.input",
      operationBinding: `sha256:${createHash("sha256").update(body).digest("base64url")}`,
      issuedAt,
      expiresAt: issuedAt + 60,
      nonce: "environment-nonce-1",
    },
  });
  return { body, token };
}

test("browser viewer control binds exact environment, actor, session, operation, and viewer-ticket scope", () => {
  const valid = viewerRequest();
  const authorized = authorizeBrowserViewerControl({
    authorization: `Bearer ${valid.token}`,
    body: valid.body,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    now: 1030,
  });
  assert.equal(authorized.instruction.sessionId, "browser-session-1");
  assert.equal(authorized.instruction.action, "input");

  const changed = Buffer.from(
    valid.body.toString("utf8").replace('"text":"x"', '"text":"y"'),
  );
  assert.throws(() =>
    authorizeBrowserViewerControl({
      authorization: `Bearer ${valid.token}`,
      body: changed,
      publicKey: environmentPublicKey,
      environmentId: "env-1",
      expectedAppName: "environment-app",
      now: 1030,
    }),
  );

  for (const scoped of [
    viewerRequest({ envelopeProjectId: "project-other" }),
    viewerRequest({ environmentId: "env-other" }),
    viewerRequest({ appName: "environment-other" }),
  ]) {
    assert.throws(() =>
      authorizeBrowserViewerControl({
        authorization: `Bearer ${scoped.token}`,
        body: scoped.body,
        publicKey: environmentPublicKey,
        environmentId: "env-1",
        expectedAppName: "environment-app",
        now: 1030,
      }),
    );
  }
});

test("browser viewer control forwards only the worker instruction to the exact private machine", async () => {
  const now = Math.floor(Date.now() / 1000);
  const input = viewerRequest({ nowSeconds: now });
  const capture = responseCapture();
  await handleBrowserViewerControl({
    request: incoming(input.body, input.token),
    response: capture.response,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(
        String(url),
        "http://machine-1.vm.environment-app.internal:43105/v1/viewer",
      );
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      const forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(forwarded).sort(), [
        "action",
        "connectionId",
        "leaseId",
        "ticket",
        "viewerInput",
      ]);
      assert.equal(forwarded.action, "input");
      assert.equal("viewerPublicKeyPem" in forwarded, false);
      assert.equal("organizationId" in forwarded, false);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  assert.equal(capture.status, 200);
  assert.deepEqual(JSON.parse(capture.body), { ok: true });
});

test("browser viewer control fails closed on worker timeout/failure and bounded request or response bodies", async () => {
  const now = Math.floor(Date.now() / 1000);
  const input = viewerRequest({ nowSeconds: now });
  const unavailable = responseCapture();
  await handleBrowserViewerControl({
    request: incoming(input.body, input.token),
    response: unavailable.response,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.ok(init?.signal instanceof AbortSignal);
      throw new Error("simulated worker timeout");
    }) as typeof fetch,
  });
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.body, /BROWSER_VIEWER_UNAVAILABLE/u);

  await assert.rejects(
    readBoundedBrowserViewerWorkerBody(
      new Response("too large", {
        headers: { "content-length": String(28 * 1024 * 1024 + 1) },
      }),
    ),
    /too large/u,
  );

  const oversized = responseCapture();
  const oversizedRequest = Readable.from([
    Buffer.alloc(64 * 1024 + 1),
  ]) as unknown as IncomingMessage;
  oversizedRequest.headers = { authorization: `Bearer ${input.token}` };
  await handleBrowserViewerControl({
    request: oversizedRequest,
    response: oversized.response,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async () => {
      throw new Error("must not forward oversized request");
    }) as typeof fetch,
  });
  assert.equal(oversized.status, 403);
});

function incoming(body: Buffer, token: string) {
  const request = Readable.from([body]) as unknown as IncomingMessage;
  request.headers = { authorization: `Bearer ${token}` };
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
    get status() {
      return status;
    },
    get body() {
      return body;
    },
  };
}
