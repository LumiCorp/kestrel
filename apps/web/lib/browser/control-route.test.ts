import assert from "node:assert/strict";
import test from "node:test";
import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import {
  configureHostedBrowserServiceResolver,
  handleHostedBrowserControl,
  HOSTED_BROWSER_CONTROL_MAX_REQUEST_BYTES,
} from "./control-route";

const ticket = {
  version: 2,
  audience: "kestrel-environment-router",
  organizationId: "org-1",
  environmentId: "env-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  runId: "run-1",
  actorId: "user-1",
  agentId: "agent-1",
  capabilities: ["kestrel.tools.invoke"],
  issuedAt: 1,
  expiresAt: 2,
  nonce: "nonce-1",
  target: {
    provider: "fly",
    appName: "app-1",
    machineId: "machine-1",
  },
} as EnvironmentExecutionTicket;

test("Browser control rejects a declared body above the exact 20 MiB limit", async () => {
  const response = await handleHostedBrowserControl({
    request: new Request("https://one.example.test/control", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(HOSTED_BROWSER_CONTROL_MAX_REQUEST_BYTES + 1),
      },
      body: "{}",
    }),
    action: "accept",
    ticket,
    projectId: "project-1",
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: { code: "BROWSER_CONTROL_BODY_TOO_LARGE" },
  });
});

test("Browser control counts the actual body when Content-Length is absent", async () => {
  const response = await handleHostedBrowserControl({
    request: new Request("https://one.example.test/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"padding":"${"x".repeat(HOSTED_BROWSER_CONTROL_MAX_REQUEST_BYTES)}"}`,
    }),
    action: "accept",
    ticket,
    projectId: "project-1",
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: { code: "BROWSER_CONTROL_BODY_TOO_LARGE" },
  });
});

test("Browser control logs a bounded service-resolution stage", async () => {
  const messages: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => messages.push(args);
  const dispose = configureHostedBrowserServiceResolver(async () => {
    throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  });
  try {
    const response = await handleHostedBrowserControl({
      request: new Request("https://one.example.test/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      action: "accept",
      ticket,
      projectId: "project-1",
    });
    assert.equal(response.status, 503);
    assert.deepEqual(messages, [
      [
        "Hosted Browser control unavailable",
        {
          code: "BROWSER_SERVICE_UNAVAILABLE",
          action: "accept",
          failureStage: "control.service_resolution",
        },
      ],
    ]);
  } finally {
    dispose();
    console.error = original;
  }
});

test("Browser control logs only bounded origin mismatch codes", async () => {
  const messages: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => messages.push(args);
  const dispose = configureHostedBrowserServiceResolver(async () => {
    throw Object.assign(new Error("BROWSER_SERVICE_UNAVAILABLE"), {
      code: "BROWSER_SERVICE_UNAVAILABLE",
      details: {
        failureStage: "origin.store",
        originMismatches: ["turn_binding_missing"],
      },
    });
  });
  try {
    const response = await handleHostedBrowserControl({
      request: new Request("https://one.example.test/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      action: "accept",
      ticket,
      projectId: "project-1",
    });
    assert.equal(response.status, 503);
    assert.deepEqual(messages, [
      [
        "Hosted Browser control unavailable",
        {
          code: "BROWSER_SERVICE_UNAVAILABLE",
          action: "accept",
          failureStage: "origin.store",
          originMismatches: ["turn_binding_missing"],
        },
      ],
    ]);
  } finally {
    dispose();
    console.error = original;
  }
});
