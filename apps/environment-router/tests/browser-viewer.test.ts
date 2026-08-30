import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import { HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES } from "@kestrel-agents/protocol";
import {
  issueHostedBrowserViewerCleanupCapability,
  issueHostedBrowserViewerTicket,
} from "../../../src/browser/hostedViewer.js";
import {
  authorizeBrowserViewerCleanup,
  authorizeBrowserViewerControl,
  handleBrowserViewerControl,
  readBoundedBrowserViewerWorkerBody,
} from "../src/browser-viewer.js";
import { startHostedBrowserWorker } from "../../../src/browser/hostedWorkerServer.js";

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
  ticketIssuedAtSeconds?: number;
  envelopeProjectId?: string;
  ticketProjectId?: string;
  environmentId?: string;
  appName?: string;
  action?: "connect" | "frame" | "input";
  ticketConnectionId?: string;
  instructionConnectionId?: string | undefined;
  omitInstructionConnection?: boolean;
}) {
  const issuedAt = input?.nowSeconds ?? 1000;
  const environmentId = input?.environmentId ?? "env-1";
  const action = input?.action ?? "input";
  const ticketConnectionId = input?.ticketConnectionId ?? "connection-1";
  const instructionConnectionId =
    input?.instructionConnectionId ?? "connection-1";
  const ticketIssuedAt = input?.ticketIssuedAtSeconds ?? issuedAt;
  const viewerTicket = issueHostedBrowserViewerTicket({
    privateKeyPem: viewerPrivateKey,
    now: new Date(ticketIssuedAt * 1000),
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
      connectionId: ticketConnectionId,
      nonce: "viewer-nonce-1",
      issuedAt: new Date(ticketIssuedAt * 1000).toISOString(),
      expiresAt: new Date((ticketIssuedAt + 60) * 1000).toISOString(),
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
      action,
      operation: `viewer.${action}`,
      viewerTicket,
      machine: {
        appName: input?.appName ?? "environment-app",
        machineId: "machine-1",
      },
      ...(input?.omitInstructionConnection
        ? {}
        : { connectionId: instructionConnectionId }),
      ...(action === "input"
        ? {
            leaseId: "lease-1",
            viewerInput: {
              version: "desktop_browser_viewer_input_v1",
              kind: "keyboard",
              phase: "down",
              key: "x",
              text: "x",
            },
          }
        : {}),
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
      operation: `viewer.${action}`,
      operationBinding: `sha256:${createHash("sha256").update(body).digest("base64url")}`,
      issuedAt,
      expiresAt: issuedAt + 60,
      nonce: "environment-nonce-1",
    },
  });
  return { body, token };
}

function viewerCleanupRequest(input?: {
  connectionId?: string;
  capabilityConnectionId?: string;
  purpose?: "disconnect" | "authority_loss";
  nowSeconds?: number;
}) {
  const issuedAt = input?.nowSeconds ?? 1000;
  const connectionId = input?.connectionId ?? "connection-1";
  const cleanupCapability = issueHostedBrowserViewerCleanupCapability({
    privateKeyPem: viewerPrivateKey,
    now: new Date(issuedAt * 1000),
    claims: {
      version: "hosted_browser_viewer_cleanup_capability_v1",
      audience: "kestrel-one-browser-viewer-cleanup",
      action: "cleanup",
      purpose: input?.purpose ?? "disconnect",
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 3,
      actorId: "user-1",
      connectionId: input?.capabilityConnectionId ?? connectionId,
      nonce: "cleanup-nonce-1",
      issuedAt: new Date(issuedAt * 1000).toISOString(),
      expiresAt: new Date((issuedAt + 60) * 1000).toISOString(),
    },
  });
  const envelope = {
    version: "hosted_browser_viewer_cleanup_router_envelope_v1",
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    userId: "user-1",
    threadId: "thread-1",
    runId: "run-1",
    instruction: {
      version: "hosted_browser_viewer_cleanup_instruction_v1",
      sessionId: "browser-session-1",
      generation: 3,
      connectionId,
      operation: "viewer.cleanup",
      purpose: input?.purpose ?? "disconnect",
      cleanupCapability,
      machine: { appName: "environment-app", machineId: "machine-1" },
    },
  };
  const body = Buffer.from(JSON.stringify(envelope));
  const token = signEnvironmentToolCredential({
    privateKey: environmentPrivateKey,
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
      capability: "browser.viewer.cleanup",
      operation: "viewer.cleanup",
      operationBinding: `sha256:${createHash("sha256").update(body).digest("base64url")}`,
      issuedAt,
      expiresAt: issuedAt + 60,
      nonce: "cleanup-environment-nonce-1",
    },
  });
  return { body, token };
}

test("browser viewer cleanup uses a separate body-bound control-plane credential", () => {
  const valid = viewerCleanupRequest();
  assert.equal(authorizeBrowserViewerCleanup({
    authorization: `Bearer ${valid.token}`,
    body: valid.body,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    now: 1030,
  }).instruction.connectionId, "connection-1");

  const changed = Buffer.from(
    valid.body.toString("utf8").replace("connection-1", "connection-other"),
  );
  assert.throws(() => authorizeBrowserViewerCleanup({
    authorization: `Bearer ${valid.token}`,
    body: changed,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    now: 1030,
  }));
});

test("browser viewer cleanup forwards only the worker-verifiable exact capability", async () => {
  const now = Math.floor(Date.now() / 1000);
  const input = viewerCleanupRequest({ nowSeconds: now });
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
        "http://machine-1.vm.environment-app.internal:43105/v1/viewer-cleanup",
      );
      const forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(forwarded).sort(), [
        "actorId",
        "cleanupCapability",
        "connectionId",
        "environmentId",
        "generation",
        "organizationId",
        "projectId",
        "purpose",
        "sessionId",
        "threadId",
      ]);
      assert.equal(forwarded.connectionId, "connection-1");
      assert.equal(forwarded.purpose, "disconnect");
      assert.equal(typeof forwarded.cleanupCapability, "string");
      assert.equal("viewerTicket" in forwarded, false);
      return new Response("null", { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(capture.status, 200);
});

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

test("browser viewer connect requires the exact connection selected by its signed ticket", () => {
  const exact = viewerRequest({ action: "connect" });
  assert.doesNotThrow(() =>
    authorizeBrowserViewerControl({
      authorization: `Bearer ${exact.token}`,
      body: exact.body,
      publicKey: environmentPublicKey,
      environmentId: "env-1",
      expectedAppName: "environment-app",
      now: 1030,
    }),
  );

  for (const rejected of [
    viewerRequest({
      action: "connect",
      instructionConnectionId: "connection-other",
    }),
    viewerRequest({ action: "connect", omitInstructionConnection: true }),
  ]) {
    assert.throws(() =>
      authorizeBrowserViewerControl({
        authorization: `Bearer ${rejected.token}`,
        body: rejected.body,
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

test("browser viewer control authenticates an expired exact ticket and preserves the worker expiry code", async () => {
  const now = Math.floor(Date.now() / 1000);
  const input = viewerRequest({ nowSeconds: now, ticketIssuedAtSeconds: now - 61 });
  const capture = responseCapture();
  await handleBrowserViewerControl({
    request: incoming(input.body, input.token),
    response: capture.response,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async () => new Response(JSON.stringify({
      error: { code: "BROWSER_VIEWER_AUTHORITY_EXPIRED" },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });
  assert.equal(capture.status, 400);
  assert.deepEqual(JSON.parse(capture.body), {
    error: { code: "BROWSER_VIEWER_AUTHORITY_EXPIRED" },
  });
});

test("browser viewer control preserves the exact pre-effect worker lease-expiry code", async () => {
  const now = Math.floor(Date.now() / 1000);
  const input = viewerRequest({ nowSeconds: now });
  const capture = responseCapture();
  await handleBrowserViewerControl({
    request: incoming(input.body, input.token),
    response: capture.response,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async () => new Response(JSON.stringify({
      error: { code: "BROWSER_VIEWER_AUTHORITY_EXPIRED" },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });
  assert.equal(capture.status, 400);
  assert.match(capture.body, /BROWSER_VIEWER_AUTHORITY_EXPIRED/u);
});

test("browser viewer control preserves transient frame unavailability from the worker", async () => {
  const now = Math.floor(Date.now() / 1000);
  const input = viewerRequest({ nowSeconds: now, action: "frame" });
  const capture = responseCapture();
  await handleBrowserViewerControl({
    request: incoming(input.body, input.token),
    response: capture.response,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async () => new Response(JSON.stringify({
      error: {
        code: "BROWSER_VIEWER_FRAME_UNAVAILABLE",
        details: { browserOutcomeKnown: true },
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  assert.equal(capture.status, 400);
  assert.deepEqual(JSON.parse(capture.body), {
    error: { code: "BROWSER_VIEWER_FRAME_UNAVAILABLE" },
  });
});

test("browser viewer control preserves a bounded oversized-frame rejection", async () => {
  const now = Math.floor(Date.now() / 1000);
  const input = viewerRequest({ nowSeconds: now, action: "frame" });
  const capture = responseCapture();
  await handleBrowserViewerControl({
    request: incoming(input.body, input.token),
    response: capture.response,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async () => new Response(JSON.stringify({
      error: {
        code: "BROWSER_ARTIFACT_TOO_LARGE",
        details: { browserOutcomeKnown: true },
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  assert.equal(capture.status, 400);
  assert.deepEqual(JSON.parse(capture.body), {
    error: { code: "BROWSER_ARTIFACT_TOO_LARGE" },
  });
});

test("browser viewer frame errors retain the ordinary 20 MiB control-response bound", async () => {
  const now = Math.floor(Date.now() / 1000);
  const input = viewerRequest({ nowSeconds: now, action: "frame" });
  const capture = responseCapture();
  await handleBrowserViewerControl({
    request: incoming(input.body, input.token),
    response: capture.response,
    publicKey: environmentPublicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async () => new Response(
      Buffer.alloc(20 * 1024 * 1024 + 1),
      { status: 400 },
    )) as typeof fetch,
  });

  assert.equal(capture.status, 503);
  assert.deepEqual(JSON.parse(capture.body), {
    error: { code: "BROWSER_VIEWER_UNAVAILABLE" },
  });
});

test("Web-shaped Router requests preserve ticket and lease expiry from the real worker boundary", async () => {
  let viewerCalls = 0;
  const worker = startHostedBrowserWorker({
    config: {
      sessionId: "browser-session-1",
      generation: 3,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      engineRevision: "v0.35.0",
      chromeRevision: "152.0.7977.54",
      effectiveAllowlistRevision: "revision-1",
      imageDigest: `registry.fly.io/kestrel-one-browser-worker@sha256:${"a".repeat(64)}`,
      capabilityPublicKeyPem: viewerPublicKey,
      gatewayHost: "gateway-machine-1.vm.browser-workers.internal",
      gatewayAddress: "127.0.0.1",
      gatewayPort: 43_109,
      engineExecutablePath: process.execPath,
      chromeExecutablePath: process.execPath,
      port: 0,
    },
    engine: {
      async execute() { throw new Error("not called"); },
      async adopt() { return 0; },
      async viewer() {
        viewerCalls += 1;
        throw new Error("BROWSER_VIEWER_AUTHORITY_EXPIRED");
      },
      async destroy() {},
    },
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const throughWorker = (async (_url: string | URL | Request, init?: RequestInit) =>
    await fetch(`http://[::1]:${port}/v1/viewer`, init)) as typeof fetch;
  const now = Math.floor(Date.now() / 1000);
  for (const input of [
    viewerRequest({ nowSeconds: now, ticketIssuedAtSeconds: now - 61 }),
    viewerRequest({ nowSeconds: now }),
  ]) {
    const capture = responseCapture();
    await handleBrowserViewerControl({
      request: incoming(input.body, input.token),
      response: capture.response,
      publicKey: environmentPublicKey,
      environmentId: "env-1",
      expectedAppName: "environment-app",
      fetchImpl: throughWorker,
    });
    assert.equal(capture.status, 400);
    assert.match(capture.body, /BROWSER_VIEWER_AUTHORITY_EXPIRED/u);
  }
  assert.equal(viewerCalls, 1);
  await worker.close();
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

  const exactFrame = await readBoundedBrowserViewerWorkerBody(
    new Response(Buffer.alloc(HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES)),
    true,
  );
  assert.equal(
    exactFrame.byteLength,
    HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES,
  );
  await assert.rejects(readBoundedBrowserViewerWorkerBody(
    new Response("too large", {
      headers: {
        "content-length": String(
          HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES + 1,
        ),
      },
    }),
    true,
  ), /too large/u);
  await assert.rejects(readBoundedBrowserViewerWorkerBody(
    new Response("too large", {
      headers: { "content-length": String(20 * 1024 * 1024 + 1) },
    }),
  ), /too large/u);

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
