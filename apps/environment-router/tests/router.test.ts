import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  signEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import {
  authorizeEnvironmentHttpRequest,
  authorizeEnvironmentRequest,
  authorizeEnvironmentSubscription,
} from "../src/router.js";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const token = signEnvironmentExecutionTicket({
  privateKey,
  ticket: {
    version: 1,
    audience: ENVIRONMENT_ROUTER_AUDIENCE,
    organizationId: "org-1",
    environmentId: "env-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-1",
    actorId: "user-1",
    agentId: "kestrel-one",
    flyAppName: "kestrel-env-1",
    flyMachineId: "machine-1",
    capabilities: [
      "run.stream",
      "profile.read",
      "workspace.files.read",
      "events.subscribe",
    ],
    issuedAt: 1000,
    expiresAt: 1300,
    nonce: "nonce-1",
  },
});
const terminalToken = signEnvironmentExecutionTicket({
  privateKey,
  ticket: {
    version: 1,
    audience: ENVIRONMENT_ROUTER_AUDIENCE,
    organizationId: "org-1",
    environmentId: "env-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-2",
    actorId: "user-1",
    agentId: "kestrel-one",
    flyAppName: "kestrel-env-1",
    flyMachineId: "machine-1",
    capabilities: ["workspace.terminal.exec"],
    issuedAt: 1000,
    expiresAt: 1300,
    nonce: "nonce-2",
  },
});
const promotionToken = signEnvironmentExecutionTicket({
  privateKey,
  ticket: {
    version: 1,
    audience: ENVIRONMENT_ROUTER_AUDIENCE,
    organizationId: "org-1",
    environmentId: "env-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-3",
    actorId: "user-1",
    agentId: "kestrel-one",
    flyAppName: "kestrel-env-1",
    flyMachineId: "machine-1",
    capabilities: [
      "workspace.promotions.read",
      "workspace.promotions.apply",
    ],
    issuedAt: 1000,
    expiresAt: 1300,
    nonce: "nonce-3",
  },
});
const reasoningReadToken = signEnvironmentExecutionTicket({
  privateKey,
  ticket: {
    version: 1,
    audience: ENVIRONMENT_ROUTER_AUDIENCE,
    organizationId: "org-1",
    environmentId: "env-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-admin",
    actorId: "admin-1",
    agentId: "kestrel-control-plane",
    flyAppName: "kestrel-env-1",
    flyMachineId: "machine-1",
    capabilities: ["reasoning.read"],
    issuedAt: 1000,
    expiresAt: 1300,
    nonce: "nonce-reasoning-read",
  },
});

test("router binds event subscriptions to the ticket Thread", () => {
  assert.equal(
    authorizeEnvironmentSubscription({
      authorization: `Bearer ${token}`,
      publicKey,
      now: 1100,
      body: {
        metadata: { tenantId: "org-1" },
        filter: { sessionId: "thread-1" },
      },
    }).status,
    200
  );
  assert.equal(
    authorizeEnvironmentSubscription({
      authorization: `Bearer ${token}`,
      publicKey,
      now: 1100,
      body: {
        metadata: { tenantId: "org-1" },
        filter: { sessionId: "thread-2" },
      },
    }).status,
    403
  );
});

test("router binds retained reasoning commands to action capability, tenant, and Thread", () => {
  const command = (action: "read" | "delete", sessionId = "thread-1") => ({
    id: "command-reasoning",
    type: "operator.run.reasoning",
    payload: { runId: "runtime-run-1", sessionId, action },
    metadata: { tenantId: "org-1" },
  });
  assert.equal(authorizeEnvironmentRequest({
    authorization: `Bearer ${reasoningReadToken}`,
    publicKey,
    now: 1100,
    body: command("read"),
  }).status, 200);
  assert.equal(authorizeEnvironmentRequest({
    authorization: `Bearer ${reasoningReadToken}`,
    publicKey,
    now: 1100,
    body: command("delete"),
  }).status, 403);
  assert.equal(authorizeEnvironmentRequest({
    authorization: `Bearer ${reasoningReadToken}`,
    publicKey,
    now: 1100,
    body: command("read", "thread-2"),
  }).status, 403);
});

test("router authorizes Workspace HTTP APIs by exact method and path", () => {
  assert.equal(authorizeEnvironmentHttpRequest({
    authorization: `Bearer ${token}`,
    publicKey,
    now: 1100,
    method: "GET",
    pathname: "/v1/tree",
  }).status, 200);
  assert.equal(authorizeEnvironmentHttpRequest({
    authorization: `Bearer ${token}`,
    publicKey,
    now: 1100,
    method: "POST",
    pathname: "/v1/terminal/exec",
  }).status, 403);
});

test("router authorizes interactive PTY session operations exactly", () => {
  for (const [method, pathname] of [
    ["POST", "/v1/terminal/sessions"],
    ["POST", "/v1/terminal/sessions/terminal-1/input"],
    ["GET", "/v1/terminal/sessions/terminal-1/output"],
    ["DELETE", "/v1/terminal/sessions/terminal-1"],
  ] as const) {
    assert.equal(
      authorizeEnvironmentHttpRequest({
        authorization: `Bearer ${terminalToken}`,
        pathname,
        method,
        publicKey,
        now: 1100,
      }).status,
      200
    );
  }
  assert.equal(
    authorizeEnvironmentHttpRequest({
      authorization: `Bearer ${terminalToken}`,
      pathname: "/v1/terminal/sessions/terminal-1/unknown",
      method: "POST",
      publicKey,
      now: 1100,
    }).status,
    403
  );
});

test("router authorizes candidate preview and acceptance by exact path", () => {
  for (const [method, pathname] of [
    ["GET", "/v1/promotions"],
    ["GET", "/v1/promotions/promotion-1"],
    ["POST", "/v1/promotions/promotion-1/apply"],
  ] as const) {
    assert.equal(
      authorizeEnvironmentHttpRequest({
        authorization: `Bearer ${promotionToken}`,
        pathname,
        method,
        publicKey,
        now: 1100,
      }).status,
      200
    );
  }
  assert.equal(
    authorizeEnvironmentHttpRequest({
      authorization: `Bearer ${promotionToken}`,
      pathname: "/v1/promotions/promotion-1/delete",
      method: "POST",
      publicKey,
      now: 1100,
    }).status,
    403
  );
});

test("router authorizes the exact tenant and Thread into a signed Fly App", () => {
  const decision = authorizeEnvironmentRequest({
    authorization: `Bearer ${token}`,
    publicKey,
    now: 1100,
    body: {
      type: "run.start",
      metadata: { tenantId: "org-1" },
      payload: { turn: { sessionId: "thread-1" } },
    },
  });
  assert.equal(decision.status, 200);
  if (decision.status === 200) {
    assert.equal(
      decision.targetUrl,
      "http://machine-1.vm.kestrel-env-1.internal:43104"
    );
  }
});

test("router rejects a ticket issued for another Environment gateway", () => {
  assert.equal(
    authorizeEnvironmentHttpRequest({
      authorization: `Bearer ${token}`,
      publicKey,
      expectedAppName: "kestrel-env-2",
      now: 1100,
      method: "GET",
      pathname: "/v1/tree",
    }).status,
    403
  );
});

test("router rejects cross-organization and cross-Thread commands", () => {
  for (const body of [
    {
      type: "run.start",
      metadata: { tenantId: "org-2" },
      payload: { turn: { sessionId: "thread-1" } },
    },
    {
      type: "run.start",
      metadata: { tenantId: "org-1" },
      payload: { turn: { sessionId: "thread-2" } },
    },
  ]) {
    assert.equal(
      authorizeEnvironmentRequest({
        authorization: `Bearer ${token}`,
        publicKey,
        now: 1100,
        body,
      }).status,
      403
    );
  }
});

test("router rejects missing tickets and ungranted command capabilities", () => {
  assert.equal(
    authorizeEnvironmentRequest({
      authorization: undefined,
      publicKey,
      now: 1100,
      body: {},
    }).status,
    401
  );
  assert.equal(
    authorizeEnvironmentRequest({
      authorization: `Bearer ${token}`,
      publicKey,
      now: 1100,
      body: {
        type: "run.cancel",
        metadata: { tenantId: "org-1" },
        payload: { sessionId: "thread-1" },
      },
    }).status,
    403
  );
});
