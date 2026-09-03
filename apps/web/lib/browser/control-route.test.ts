import assert from "node:assert/strict";
import test from "node:test";
import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { defaultToolCatalog } from "../../../../tools/catalog.js";
import { createToolActivationRefV1, fingerprintToolScopeV1, hashCanonical } from "../../../../src/kestrel/contracts/tool-contract.js";
import { parsePreparedToolCallV1 } from "../../../../src/kestrel/contracts/tool-invocation.js";
import type { HostedBrowserService } from "./service";
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

test("private startup-failure control parses exact authority and rejects malformed instructions", async () => {
  const descriptor = defaultToolCatalog.getDescriptorRef("browser.open");
  assert.ok(descriptor);
  const prepared = parsePreparedToolCallV1({
    version: "v1", runId: "run-1", sessionId: "runtime-session-1", callId: "call-1",
    activation: createToolActivationRefV1({ descriptor, registryGeneration: "test", scopeFingerprint: fingerprintToolScopeV1({ hostedBrowser: true }) }),
    origin: { kind: "trusted_runtime", producerId: "test", adapterId: "test" },
    effectiveInput: { mode: "operator", target: { kind: "public_url", url: "https://example.com/" } },
    policy: { decision: "allow", policyRevision: hashCanonical({ revision: 1 }), reasonCode: "environment_policy" },
    preparedAt: "2026-09-03T12:00:00.000Z",
  });
  const authority = { threadId: "thread-1", projectId: "project-1" };
  const instruction = {
    version: "hosted_browser_relay_instruction_v1", phase: "accept", operation: "browser.open",
    operationId: prepared.callId, sessionId: "browser-session-1", generation: 1,
    capability: "private-test-capability", prepared,
    authority: { effectiveAllowlistRevision: "revision-1" },
    machine: { appName: "app-1", machineId: "machine-1" },
  };
  let calls = 0;
  const dispose = configureHostedBrowserServiceResolver(async () => ({
    async failOpeningOperation(actualPrepared, actualAuthority, actualInstruction) {
      calls += 1;
      assert.deepEqual(actualPrepared, prepared);
      assert.deepEqual(actualAuthority, authority);
      assert.deepEqual(actualInstruction, instruction);
      return true;
    },
  }) as HostedBrowserService);
  const request = (candidate: unknown) => handleHostedBrowserControl({
    request: new Request("https://one.example.test/control", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prepared, authority, instruction: candidate }),
    }),
    action: "startup-failed", ticket, projectId: "project-1",
  });
  try {
    const response = await request(instruction);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cleaned: true, operationId: prepared.callId });
    for (const invalid of [null, { ...instruction, generation: "1" }, { ...instruction, phase: "invoke" }, { ...instruction, machine: null }, { ...instruction, prepared: [] }]) {
      assert.notEqual((await request(invalid)).status, 200);
    }
    assert.equal(calls, 1);
  } finally {
    dispose();
  }
});

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
