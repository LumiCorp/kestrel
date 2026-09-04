import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { ENVIRONMENT_GATEWAY_CONFIG_VERSION } from "@lumi/kestrel-environment-auth";
import {
  handleAppRelay,
  isAllowedAppRequest,
  MAX_APP_RELAY_SERIALIZED_BYTES,
  APP_RELAY_REQUEST_TIMEOUT_MS,
  BROWSER_ACCEPT_REQUEST_TIMEOUT_MS,
} from "../src/app-relay.js";
import {
  HostedBrowserEgressRegistry,
  type HostedBrowserGatewayAuthorityV1,
  type HostedBrowserGatewayProxyBindingV1,
} from "../src/browser-egress.js";
import { EnvironmentGatewayConfigClient } from "../src/gateway-config.js";

// The Gateway reads only expiry; the worker owns signature validation.
function readinessCapability(expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return `${Buffer.from(JSON.stringify({ expiresAt })).toString("base64url")}.fixture-signature`;
}

test("ordinary App relay uses the settled 20 MiB serialized payload ceiling", () => {
  assert.equal(MAX_APP_RELAY_SERIALIZED_BYTES, 20 * 1024 * 1024);
  assert.equal(APP_RELAY_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(BROWSER_ACCEPT_REQUEST_TIMEOUT_MS, 120_000);
});

test("app relay refreshes expired execution tickets and enforces workspace and path scope", async () => {
  const observed: Array<Record<string, unknown>> = [];
  const controlPlane = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    observed.push({
      path: request.url,
      authorization: request.headers.authorization,
      approvalId: request.headers["x-kestrel-approval-id"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    if (request.headers.authorization === "Bearer stale-ticket") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "TICKET_EXPIRED" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  controlPlane.listen(0, "127.0.0.1");
  await once(controlPlane, "listening");
  const address = controlPlane.address();
  assert.ok(address && typeof address !== "string");

  const environmentId = randomUUID();
  const workspaceId = randomUUID();
  const runId = randomUUID();
  const workspaceToken = "workspace-secret";
  let refreshCount = 0;
  const config = new EnvironmentGatewayConfigClient({
    controlPlaneUrl: `http://127.0.0.1:${address.port}`,
    environmentId,
    serviceToken: "gateway-secret",
    fetchImpl: async () => {
      refreshCount += 1;
      return Response.json({
        version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
        environmentId,
        revision: String(refreshCount),
        workspaces: [{
          id: workspaceId,
          machineId: "machine-1",
          serviceTokenHash: createHash("sha256")
            .update(workspaceToken)
            .digest("base64url"),
        }],
        previews: [],
        modelGrants: [],
        appGrants: [{
          executionId: runId,
          runId: "runtime-run-1",
          workspaceId,
          executionTicket: refreshCount === 1 ? "stale-ticket" : "fresh-ticket",
          credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }],
      });
    },
  });
  await config.refresh();
  const relay = createServer((request, response) => {
    void handleAppRelay({ request, response, config });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");

  try {
    const response = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/apps/${runId}/api/runtime/email/action`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${workspaceToken}`,
          "content-type": "application/json",
          "x-kestrel-approval-id": "approval-1",
        },
        body: JSON.stringify({ operation: "list" }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(refreshCount, 2);
    assert.deepEqual(observed, [
      {
        path: "/api/runtime/email/action",
        authorization: "Bearer stale-ticket",
        approvalId: "approval-1",
        body: { operation: "list" },
      },
      {
        path: "/api/runtime/email/action",
        authorization: "Bearer fresh-ticket",
        approvalId: "approval-1",
        body: { operation: "list" },
      },
    ]);

    const wrongRun = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/apps/${randomUUID()}/api/runtime/email/action`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${workspaceToken}` },
      },
    );
    assert.equal(wrongRun.status, 403);

    const deniedPath = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/apps/${runId}/api/runtime/not-allowlisted`,
      { headers: { authorization: `Bearer ${workspaceToken}` } },
    );
    assert.equal(deniedPath.status, 404);

    const arbitraryAppPath = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/apps/${runId}/api/runtime/apps/arbitrary/read/auto/data`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${workspaceToken}` },
      },
    );
    assert.equal(arbitraryAppPath.status, 404);
  } finally {
    relay.close();
    controlPlane.close();
    config.stop();
  }
});

test("app relay allowlists only supported app methods and contracts", () => {
  assert.equal(isAllowedAppRequest(
    "/api/kestrel/tools/email/get-attachment",
    "POST",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/kestrel/tools/email/get-attachment",
    "GET",
  ), false);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.previews/inspect/auto/ports/3000",
    "GET",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.previews/inspect/auto/ports/3000",
    "POST",
  ), false);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.weather/forecast/auto/timeline",
    "POST",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/tavily/research_status/auto/research/request-1",
    "GET",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/vercel/operations.read/confirmed/deployment-events",
    "POST",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/arbitrary/read/auto/data",
    "POST",
  ), false);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.browser/navigate/auto/control/accept",
    "POST",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.browser/navigate/auto/control/invoke",
    "POST",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.browser/navigate/auto/control/commit",
    "POST",
  ), true);
  for (const internalAction of ["complete", "unknown", "adopt-complete"]) {
    assert.equal(isAllowedAppRequest(
      `/api/runtime/apps/built_in.browser/navigate/auto/control/${internalAction}`,
      "POST",
    ), false);
  }
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.browser/navigate/auto/control/raw-socket",
    "POST",
  ), false);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/apps/built_in.browser/navigate/auto/control/accept",
    "GET",
  ), false);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/github/credentials",
    "POST",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/github/push",
    "POST",
  ), true);
  assert.equal(isAllowedAppRequest(
    "/api/runtime/github/push",
    "GET",
  ), false);
});

test("Browser relay keeps private worker authority out of the runner and invokes once after acceptance", async () => {
  const fixture = await createRelayFixture();
  const controlPaths: string[] = [];
  const workerPaths: string[] = [];
  const privateInstruction = {
    version: "hosted_browser_relay_instruction_v1",
    operationId: "call-1",
    operation: "browser.navigate",
    sessionId: "browser-session-1",
    generation: 1,
    capability: "private-signed-capability",
    machine: { appName: "kestrel-env-test", machineId: "machine-browser-1" },
  };
  const relay = createServer((request, response) => {
    void handleAppRelay({
      request,
      response,
      config: fixture.config,
      fetchImpl: (async (url) => {
        const path = new URL(String(url)).pathname;
        controlPaths.push(path);
        if (path.endsWith("/accept")) {
          return Response.json({
            ...privateInstruction,
            phase: "accept",
            prepared: { callId: "call-1" },
            authority: { effectiveAllowlistRevision: "revision-1" },
          });
        }
        if (path.endsWith("/invoke")) {
          return Response.json({ ...privateInstruction, phase: "invoke" });
        }
        if (path.endsWith("/complete")) {
          return Response.json({
            version: "browser_tool_result_v1",
            operation: "browser.navigate",
            outcome: "navigated",
          });
        }
        return Response.json({ error: { code: "unexpected" } }, { status: 500 });
      }) as typeof fetch,
      browserWorkerFetchImpl: (async (url) => {
        const path = new URL(String(url)).pathname;
        workerPaths.push(path);
        if (path.endsWith("/accept")) return Response.json({
          accepted: true,
          operationId: "call-1",
          sessionId: "browser-session-1",
          generation: 1,
          identity: {
            sessionId: "browser-session-1",
            generation: 1,
            engineRevision: "v0.35.0",
            chromeRevision: "152.0.7977.54",
            imageDigest: `registry.fly.io/browser@sha256:${"a".repeat(64)}`,
          },
        });
        if (path.endsWith("/commit")) {
          return Response.json({ committed: true, operationId: "call-1" });
        }
        return Response.json({
          version: "browser_tool_result_v1",
          operation: "browser.navigate",
          outcome: "navigated",
        });
      }) as typeof fetch,
    });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/navigate/auto/control`;
  const headers = {
    authorization: `Bearer ${fixture.workspaceToken}`,
    "content-type": "application/json",
  };
  try {
    const accepted = await fetch(`${base}/accept`, {
      method: "POST", headers, body: JSON.stringify({ prepared: { callId: "call-1" } }),
    });
    assert.equal(accepted.status, 200);
    const receipt = await accepted.json() as Record<string, unknown>;
    assert.equal(receipt.operationId, "call-1");
    assert.equal(typeof receipt.receiptId, "string");
    assert.doesNotMatch(JSON.stringify(receipt), /private-signed-capability|machine-browser/u);
    const invoked = await fetch(`${base}/invoke`, {
      method: "POST", headers,
      body: JSON.stringify({ prepared: { callId: "call-1" }, receipt }),
    });
    assert.equal(invoked.status, 200);
    const invocation = await invoked.json() as {
      output: { outcome: string };
      commitReceipt: Record<string, unknown>;
    };
    assert.equal(invocation.output.outcome, "navigated");
    const committed = await fetch(`${base}/commit`, {
      method: "POST", headers,
      body: JSON.stringify({ receipt: invocation.commitReceipt }),
    });
    assert.equal(committed.status, 200);
    assert.deepEqual(workerPaths, [
      "/v1/operations/accept",
      "/v1/operations/invoke",
      "/v1/operations/commit",
    ]);
    assert.deepEqual(controlPaths.map((path) => path.split("/").at(-1)), ["accept", "invoke", "complete"]);
  } finally {
    relay.close();
    fixture.config.stop();
  }
});

test("Browser upload relay stages bytes before exposing the invoke continuation", async () => {
  const fixture = await createRelayFixture();
  const workerPaths: string[] = [];
  const instruction = {
    version: "hosted_browser_relay_instruction_v1",
    operationId: "call-upload-stage",
    operation: "browser.upload",
    sessionId: "browser-session-upload",
    generation: 1,
    capability: "private-upload-capability",
    machine: { appName: "kestrel-env-test", machineId: "machine-browser-upload" },
  };
  const relay = createServer((request, response) => void handleAppRelay({
    request,
    response,
    config: fixture.config,
    fetchImpl: (async (url) => {
      const pathName = new URL(String(url)).pathname;
      if (pathName.endsWith("/accept")) {
        return Response.json({
          ...instruction,
          phase: "accept",
          prepared: { callId: instruction.operationId },
          authority: { effectiveAllowlistRevision: "revision-1" },
        });
      }
      if (pathName.endsWith("/invoke")) {
        return Response.json({ ...instruction, phase: "invoke" });
      }
      if (pathName.endsWith("/complete")) {
        return Response.json({
          version: "browser_tool_result_v1",
          operation: "browser.upload",
          outcome: "uploaded",
        });
      }
      return Response.json({ error: { code: "unexpected" } }, { status: 500 });
    }) as typeof fetch,
    browserWorkerFetchImpl: (async (url) => {
      const pathName = new URL(String(url)).pathname;
      workerPaths.push(pathName);
      if (pathName.endsWith("/accept")) {
        return Response.json({
          accepted: true,
          operationId: instruction.operationId,
          sessionId: instruction.sessionId,
          generation: 1,
          identity: {
            sessionId: instruction.sessionId,
            generation: 1,
            engineRevision: "v0.35.0",
            chromeRevision: "152.0.7977.54",
            imageDigest: `registry.fly.io/browser@sha256:${"a".repeat(64)}`,
          },
        });
      }
      return Response.json({
        version: "browser_tool_result_v1",
        operation: "browser.upload",
        outcome: "uploaded",
      });
    }) as typeof fetch,
  }));
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/upload/auto/control`;
  const headers = {
    authorization: `Bearer ${fixture.workspaceToken}`,
    "content-type": "application/json",
  };
  try {
    const accepted = await fetch(`${base}/accept`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prepared: { callId: instruction.operationId } }),
    });
    const receipt = await accepted.json();
    const staged = await fetch(`${base}/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prepared: { callId: instruction.operationId }, receipt }),
    });
    assert.equal(staged.status, 200);
    const stagedReceipt = await staged.json() as Record<string, unknown>;
    assert.equal(stagedReceipt.version, "hosted_browser_upload_staged_receipt_v1");
    assert.deepEqual(workerPaths, ["/v1/operations/accept"]);
    const mismatched = await fetch(`${base}/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prepared: { callId: instruction.operationId },
        receipt: { ...stagedReceipt, operationId: "call-upload-other" },
      }),
    });
    assert.equal(mismatched.status, 409);
    assert.deepEqual(workerPaths, ["/v1/operations/accept"]);
    const invoked = await fetch(`${base}/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prepared: { callId: instruction.operationId },
        receipt: stagedReceipt,
      }),
    });
    assert.equal(invoked.status, 200);
    assert.deepEqual(workerPaths, [
      "/v1/operations/accept",
      "/v1/operations/invoke",
    ]);
  } finally {
    relay.close();
    fixture.config.stop();
  }
});

test("Browser upload staging is known pre-effect only after exact worker cancellation proof", async () => {
  for (const [cancelProven, expectedCode] of [
    [true, "BROWSER_SERVICE_UNAVAILABLE"],
    [false, "BROWSER_ACTION_OUTCOME_UNKNOWN"],
  ] as const) {
    const fixture = await createRelayFixture();
    const instruction = {
      version: "hosted_browser_relay_instruction_v1",
      operationId: `call-upload-cancel-${String(cancelProven)}`,
      operation: "browser.upload",
      sessionId: `browser-session-upload-${String(cancelProven)}`,
      generation: 1,
      capability: "private-upload-capability",
      machine: { appName: "kestrel-env-test", machineId: "machine-browser-upload" },
    };
    let workerInvokes = 0;
    const relay = createServer((request, response) => void handleAppRelay({
      request,
      response,
      config: fixture.config,
      fetchImpl: (async (url) => {
        const pathName = new URL(String(url)).pathname;
        if (pathName.endsWith("/accept")) {
          return Response.json({
            ...instruction,
            phase: "accept",
            prepared: { callId: instruction.operationId },
            authority: { effectiveAllowlistRevision: "revision-1" },
          });
        }
        return Response.json({
          error: {
            code: "BROWSER_SERVICE_UNAVAILABLE",
            details: { browserOutcomeKnown: true },
          },
        }, { status: 503 });
      }) as typeof fetch,
      browserWorkerFetchImpl: (async (url) => {
        const pathName = new URL(String(url)).pathname;
        if (pathName.endsWith("/accept")) {
          return Response.json({
            accepted: true,
            operationId: instruction.operationId,
            sessionId: instruction.sessionId,
            generation: 1,
            identity: {
              sessionId: instruction.sessionId,
              generation: 1,
              engineRevision: "v0.35.0",
              chromeRevision: "152.0.7977.54",
              imageDigest: `registry.fly.io/browser@sha256:${"a".repeat(64)}`,
            },
          });
        }
        if (pathName.endsWith("/cancel")) {
          if (!cancelProven) throw new Error("cancel response lost");
          return Response.json({
            cancelled: true,
            operationId: instruction.operationId,
          });
        }
        workerInvokes += 1;
        return Response.json({ error: { code: "unexpected" } }, { status: 500 });
      }) as typeof fetch,
    }));
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const address = relay.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/upload/auto/control`;
    const headers = {
      authorization: `Bearer ${fixture.workspaceToken}`,
      "content-type": "application/json",
    };
    try {
      const accepted = await fetch(`${base}/accept`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prepared: { callId: instruction.operationId } }),
      });
      const receipt = await accepted.json();
      const failed = await fetch(`${base}/invoke`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prepared: { callId: instruction.operationId }, receipt }),
      });
      const payload = await failed.json() as { error: { code: string; details: { browserOutcomeKnown: boolean } } };
      assert.equal(payload.error.code, expectedCode);
      assert.equal(payload.error.details.browserOutcomeKnown, cancelProven);
      assert.equal(workerInvokes, 0);
    } finally {
      relay.close();
      fixture.config.stop();
    }
  }
});

test("Browser download staging cancels only a proven known pre-effect failure", async () => {
  for (const scenario of [
    {
      name: "known with cancellation proof",
      controlCode: "BROWSER_SERVICE_UNAVAILABLE",
      controlThrows: false,
      cancelProven: true,
      expectedCode: "BROWSER_SERVICE_UNAVAILABLE",
      expectedKnown: true,
      expectedCancellations: 1,
    },
    {
      name: "known without cancellation proof",
      controlCode: "BROWSER_SERVICE_UNAVAILABLE",
      controlThrows: false,
      cancelProven: false,
      expectedCode: "BROWSER_ACTION_OUTCOME_UNKNOWN",
      expectedKnown: false,
      expectedCancellations: 1,
    },
    {
      name: "ready file outcome unknown",
      controlCode: "BROWSER_ACTION_OUTCOME_UNKNOWN",
      controlThrows: false,
      cancelProven: true,
      expectedCode: "BROWSER_ACTION_OUTCOME_UNKNOWN",
      expectedKnown: false,
      expectedCancellations: 0,
    },
    {
      name: "control response lost",
      controlCode: "BROWSER_ACTION_OUTCOME_UNKNOWN",
      controlThrows: true,
      cancelProven: true,
      expectedCode: "BROWSER_ACTION_OUTCOME_UNKNOWN",
      expectedKnown: false,
      expectedCancellations: 0,
    },
  ] as const) {
    const fixture = await createRelayFixture();
    const operationId = `call-download-${scenario.name.replaceAll(" ", "-")}`;
    const instruction = {
      version: "hosted_browser_relay_instruction_v1",
      operationId,
      operation: "browser.download",
      sessionId: `browser-session-${operationId}`,
      generation: 1,
      capability: `private-${operationId}`,
      machine: { appName: "kestrel-env-test", machineId: "machine-browser-download" },
    };
    let cancellations = 0;
    const relay = createServer((request, response) => void handleAppRelay({
      request,
      response,
      config: fixture.config,
      fetchImpl: (async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname.endsWith("/accept")) {
          return Response.json({
            ...instruction,
            phase: "accept",
            prepared: { callId: operationId },
            authority: { effectiveAllowlistRevision: "revision-1" },
          });
        }
        if (scenario.controlThrows) throw new Error("control response lost");
        return Response.json({
          error: {
            code: scenario.controlCode,
            details: { browserOutcomeKnown: scenario.controlCode !== "BROWSER_ACTION_OUTCOME_UNKNOWN" },
          },
        }, { status: scenario.controlCode === "BROWSER_SERVICE_UNAVAILABLE" ? 503 : 409 });
      }) as typeof fetch,
      browserWorkerFetchImpl: (async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname.endsWith("/accept")) {
          return Response.json({
            accepted: true,
            operationId,
            sessionId: instruction.sessionId,
            generation: 1,
            identity: {
              sessionId: instruction.sessionId,
              generation: 1,
              engineRevision: "v0.35.0",
              chromeRevision: "152.0.7977.54",
              imageDigest: `registry.fly.io/browser@sha256:${"a".repeat(64)}`,
            },
          });
        }
        if (pathname.endsWith("/cancel")) {
          cancellations += 1;
          if (!scenario.cancelProven) throw new Error("cancel response lost");
          return Response.json({ cancelled: true, operationId });
        }
        return Response.json({ error: { code: "unexpected" } }, { status: 500 });
      }) as typeof fetch,
    }));
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const address = relay.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/download/auto/control`;
    const headers = {
      authorization: `Bearer ${fixture.workspaceToken}`,
      "content-type": "application/json",
    };
    try {
      const accepted = await fetch(`${base}/accept`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prepared: { callId: operationId } }),
      });
      const receipt = await accepted.json();
      const failed = await fetch(`${base}/invoke`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prepared: { callId: operationId }, receipt }),
      });
      const payload = await failed.json() as {
        error: { code: string; details: { browserOutcomeKnown: boolean } };
      };
      assert.equal(payload.error.code, scenario.expectedCode, scenario.name);
      assert.equal(payload.error.details.browserOutcomeKnown, scenario.expectedKnown, scenario.name);
      assert.equal(cancellations, scenario.expectedCancellations, scenario.name);
    } finally {
      relay.close();
      fixture.config.stop();
    }
  }
});

test("Browser relay retries a transient worker transport failure inside one open acceptance", async () => {
  const fixture = await createRelayFixture();
  let controlAccepts = 0;
  const workerBodies: string[] = [];
  const instruction = {
    version: "hosted_browser_relay_instruction_v1",
    phase: "accept",
    operationId: "call-retry",
    operation: "browser.open",
    sessionId: "browser-session-retry",
    generation: 1,
    capability: readinessCapability(),
    machine: { appName: "kestrel-env-test", machineId: "machine-browser-retry" },
    prepared: { callId: "call-retry" },
    authority: { effectiveAllowlistRevision: "revision-1" },
  };
  let workerAccepts = 0;
  const relay = createServer((request, response) => void handleAppRelay({
    request, response, config: fixture.config,
    fetchImpl: (async () => {
      controlAccepts += 1;
      return Response.json(instruction);
    }) as typeof fetch,
    browserWorkerFetchImpl: (async (_url, init) => {
      workerAccepts += 1;
      assert.equal(init?.redirect, "manual", "private authority must not follow redirects");
      workerBodies.push(String(init?.body));
      if (workerAccepts === 1) throw new Error("worker response lost");
      return Response.json({
        accepted: true,
        operationId: "call-retry",
        sessionId: "browser-session-retry",
        generation: 1,
        identity: {
          sessionId: "browser-session-retry",
          generation: 1,
          engineRevision: "v0.35.0",
          chromeRevision: "152.0.7977.54",
          imageDigest: `registry.fly.io/browser@sha256:${"a".repeat(64)}`,
        },
      });
    }) as typeof fetch,
  }));
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/open/auto/control/accept`;
  const request = () => fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.workspaceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prepared: { callId: "call-retry" } }),
  });
  try {
    assert.equal((await request()).status, 200);
    assert.equal(controlAccepts, 1);
    assert.equal(workerAccepts, 2);
    assert.equal(workerBodies[1], workerBodies[0]);
  } finally {
    relay.close();
    fixture.config.stop();
  }
});

for (const status of [301, 307, 400, 409, 503]) {
test(`Browser open does not retry a worker HTTP ${status} response`, async () => {
  const fixture = await createRelayFixture();
  const egress = new RecordingBrowserEgressRegistry();
  let workerAccepts = 0;
  let startupFailures = 0;
  const instruction = {
    version: "hosted_browser_relay_instruction_v1",
    phase: "accept",
    operationId: "call-http-failure",
    operation: "browser.open",
    sessionId: "browser-session-http-failure",
    generation: 4,
    capability: readinessCapability(),
    machine: { appName: "kestrel-env-test", machineId: "machine-http-failure" },
    prepared: { callId: "call-http-failure" },
    authority: { effectiveAllowlistRevision: "revision-1" },
  };
  const relay = createServer((request, response) => void handleAppRelay({
    request,
    response,
    config: fixture.config,
    browserEgress: egress,
    fetchImpl: (async (url) => {
      if (new URL(String(url)).pathname.endsWith("/startup-failed")) {
        startupFailures += 1;
        return Response.json({ cleaned: true });
      }
      return Response.json(instruction);
    }) as typeof fetch,
    browserWorkerFetchImpl: (async (_url, init) => {
      workerAccepts += 1;
      assert.equal(init?.redirect, "manual");
      return Response.json(
        { error: { code: "BROWSER_ENGINE_FAILURE" } },
        { status },
      );
    }) as typeof fetch,
  }));
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/open/auto/control/accept`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.workspaceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prepared: { callId: "call-http-failure" } }),
      },
    );
    // Unknown worker outcomes stay fail-closed; no HTTP response is retried.
    assert.equal(response.status, 503);
    assert.equal(workerAccepts, 1);
    assert.equal(startupFailures, 1);
    assert.deepEqual(egress.closed, [{
      sessionId: "browser-session-http-failure",
      generation: 4,
    }]);
  } finally {
    relay.close();
    await egress.closeAll();
    fixture.config.stop();
  }
});

}

test("Browser open deadline closes provisional egress and notifies startup failure once", async () => {
  const fixture = await createRelayFixture();
  const egress = new RecordingBrowserEgressRegistry();
  let workerAccepts = 0;
  let startupFailures = 0;
  const instruction = {
    version: "hosted_browser_relay_instruction_v1",
    phase: "accept",
    operationId: "call-cancelled",
    operation: "browser.open",
    sessionId: "browser-session-cancelled",
    generation: 7,
    capability: readinessCapability(),
    machine: { appName: "kestrel-env-test", machineId: "machine-cancelled" },
    prepared: { callId: "call-cancelled" },
    authority: { effectiveAllowlistRevision: "revision-1" },
  };
  const relay = createServer((request, response) => void handleAppRelay({
    request,
    response,
    config: fixture.config,
    requestTimeoutMs: 10,
    browserEgress: egress,
    fetchImpl: (async (url) => {
      if (new URL(String(url)).pathname.endsWith("/startup-failed")) {
        startupFailures += 1;
        return Response.json({ cleaned: true });
      }
      return Response.json(instruction);
    }) as typeof fetch,
    browserWorkerFetchImpl: (async () => {
      workerAccepts += 1;
      throw new Error("worker unavailable");
    }) as typeof fetch,
  }));
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/open/auto/control/accept`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.workspaceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prepared: { callId: "call-cancelled" } }),
      },
    );
    assert.equal(response.status, 503);
    assert.equal(workerAccepts, 1);
    assert.equal(startupFailures, 1);
    assert.deepEqual(egress.closed, [{
      sessionId: "browser-session-cancelled",
      generation: 7,
    }]);
  } finally {
    relay.close();
    await egress.closeAll();
    fixture.config.stop();
  }
});

for (const scenario of ["malformed capability", "expired capability", "invalid Machine", "capability expiry", "client cancellation"] as const) {
  test(`Browser open fails closed on ${scenario}`, { timeout: 3000 }, async () => {
    const fixture = await createRelayFixture();
    const egress = new RecordingBrowserEgressRegistry();
    const client = new AbortController();
    let workerAccepts = 0;
    let controlAccepts = 0;
    let startupFailures = 0;
    let notifyCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { notifyCleanup = resolve; });
    const instruction = {
      version: "hosted_browser_relay_instruction_v1",
      phase: "accept",
      operationId: "call-unavailable",
      operation: "browser.open",
      sessionId: "browser-session-unavailable",
      generation: 8,
      capability: readinessCapability(),
      machine: { appName: "kestrel-env-test", machineId: "machine-unavailable" },
      prepared: { callId: "call-unavailable" },
      authority: { effectiveAllowlistRevision: "revision-1" },
    };
    const relay = createServer((request, response) => void handleAppRelay({
      request, response, config: fixture.config, browserEgress: egress,
      fetchImpl: (async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/startup-failed")) {
          startupFailures += 1;
          assert.equal(init?.signal?.aborted, false, "cleanup uses an independent signal");
          assert.deepEqual(JSON.parse(String(init?.body)).instruction, instruction);
          notifyCleanup();
          return Response.json({ cleaned: true });
        }
        controlAccepts += 1;
        if (scenario === "malformed capability") instruction.capability = "malformed";
        if (scenario === "expired capability") instruction.capability = readinessCapability(new Date(0).toISOString());
        if (scenario === "invalid Machine") instruction.machine.machineId = "invalid/locator";
        if (scenario === "capability expiry") instruction.capability = readinessCapability(new Date(Date.now() + 50).toISOString());
        return Response.json(instruction);
      }) as typeof fetch,
      browserWorkerFetchImpl: (async (_url, init) => {
        workerAccepts += 1;
        if (scenario === "client cancellation") client.abort();
        // A stalled transport must obey cancellation/expiry, without a response.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }) as typeof fetch,
    }));
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const address = relay.address();
    assert.ok(address && typeof address !== "string");
    try {
      const response = fetch(`http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/open/auto/control/accept`, {
        method: "POST", signal: client.signal,
        headers: { authorization: `Bearer ${fixture.workspaceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ prepared: instruction.prepared }),
      });
      if (scenario === "client cancellation") await assert.rejects(response, { name: "AbortError" });
      else assert.equal((await response).status, 503);
      await cleanup;
      assert.equal(controlAccepts, 1);
      assert.equal(workerAccepts, scenario === "capability expiry" || scenario === "client cancellation" ? 1 : 0);
      assert.equal(startupFailures, 1);
      assert.deepEqual(egress.closed, [{ sessionId: instruction.sessionId, generation: instruction.generation }]);
    } finally {
      relay.closeAllConnections();
      relay.close();
      await egress.closeAll();
      fixture.config.stop();
    }
  });
}

test("Browser relay returns a validated pre-dispatch result without invoking the worker", async () => {
  const fixture = await createRelayFixture();
  const controlPaths: string[] = [];
  const workerPaths: string[] = [];
  const instruction = {
    version: "hosted_browser_relay_instruction_v1",
    phase: "accept",
    operationId: "call-pre",
    operation: "browser.request_grant",
    sessionId: "browser-session-pre",
    generation: 1,
    capability: "private-capability-pre",
    machine: { appName: "kestrel-env-test", machineId: "machine-browser-pre" },
    prepared: { callId: "call-pre" },
    authority: { effectiveAllowlistRevision: "revision-1" },
  };
  const relay = createServer((request, response) => void handleAppRelay({
    request, response, config: fixture.config,
    fetchImpl: (async (url) => {
      const path = new URL(String(url)).pathname;
      controlPaths.push(path);
      if (path.endsWith("/accept")) return Response.json(instruction);
      return Response.json({
        version: "browser_tool_result_v1",
        operation: "browser.request_grant",
        outcome: "already_allowed",
      });
    }) as typeof fetch,
    browserWorkerFetchImpl: (async (url) => {
      const path = new URL(String(url)).pathname;
      workerPaths.push(path);
      if (path.endsWith("/commit")) {
        return Response.json({ committed: true, operationId: "call-pre" });
      }
      return Response.json({
        completedBeforeDispatch: true,
        operationId: "call-pre",
        sessionId: "browser-session-pre",
        generation: 1,
        identity: {
          sessionId: "browser-session-pre",
          generation: 1,
          engineRevision: "v0.35.0",
          chromeRevision: "152.0.7977.54",
          imageDigest: `registry.fly.io/browser@sha256:${"a".repeat(64)}`,
        },
        output: {
          version: "browser_tool_result_v1",
          operation: "browser.request_grant",
          outcome: "already_allowed",
        },
      });
    }) as typeof fetch,
  }));
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/request_grant/auto/control`;
  const headers = {
    authorization: `Bearer ${fixture.workspaceToken}`,
    "content-type": "application/json",
  };
  try {
    const completed = await fetch(`${base}/accept`, {
      method: "POST", headers, body: JSON.stringify({ prepared: { callId: "call-pre" } }),
    });
    assert.equal(completed.status, 200);
    const result = await completed.json() as {
      version: string;
      commitReceipt: Record<string, unknown>;
    };
    assert.equal(result.version, "hosted_browser_pre_dispatch_result_v1");
    const committed = await fetch(`${base}/commit`, {
      method: "POST", headers, body: JSON.stringify({ receipt: result.commitReceipt }),
    });
    assert.equal(committed.status, 200);
    assert.deepEqual(workerPaths, ["/v1/operations/accept", "/v1/operations/commit"]);
    assert.deepEqual(controlPaths.map((path) => path.split("/").at(-1)), ["accept", "complete"]);
  } finally {
    relay.close();
    fixture.config.stop();
  }
});

test("Browser relay preserves a definite pre-invoke policy refusal after acknowledgement", async () => {
  const fixture = await createRelayFixture();
  let workerInvokes = 0;
  let unknownNotifications = 0;
  const instruction = {
    version: "hosted_browser_relay_instruction_v1",
    operationId: "call-known",
    operation: "browser.navigate",
    sessionId: "browser-session-known",
    generation: 1,
    capability: "private-capability",
    machine: { appName: "kestrel-env-test", machineId: "machine-browser-known" },
  };
  const relay = createServer((request, response) => void handleAppRelay({
    request, response, config: fixture.config,
    fetchImpl: (async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/accept")) return Response.json({
        ...instruction, phase: "accept", prepared: { callId: "call-known" },
        authority: { effectiveAllowlistRevision: "revision-1" },
      });
      if (path.endsWith("/invoke")) return Response.json({
        error: { code: "BROWSER_DESTINATION_BLOCKED", details: { browserOutcomeKnown: true } },
      }, { status: 409 });
      if (path.endsWith("/unknown")) unknownNotifications += 1;
      return Response.json({ ok: true });
    }) as typeof fetch,
    browserWorkerFetchImpl: (async (url) => {
      if (new URL(String(url)).pathname.endsWith("/invoke")) workerInvokes += 1;
      return Response.json({
        accepted: true, operationId: "call-known", sessionId: "browser-session-known", generation: 1,
        identity: { sessionId: "browser-session-known", generation: 1, engineRevision: "v0.35.0", chromeRevision: "152.0.7977.54", imageDigest: `registry.fly.io/browser@sha256:${"a".repeat(64)}` },
      });
    }) as typeof fetch,
  }));
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/navigate/auto/control`;
  const headers = { authorization: `Bearer ${fixture.workspaceToken}`, "content-type": "application/json" };
  try {
    const accepted = await fetch(`${base}/accept`, { method: "POST", headers, body: "{}" });
    const receipt = await accepted.json();
    const refused = await fetch(`${base}/invoke`, {
      method: "POST", headers, body: JSON.stringify({ receipt, prepared: { callId: "call-known" } }),
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json() as { error: { code: string } }).error.code, "BROWSER_DESTINATION_BLOCKED");
    assert.equal(workerInvokes, 0);
    assert.equal(unknownNotifications, 0);
  } finally {
    relay.close();
    fixture.config.stop();
  }
});

test("Browser close commit revokes its exact egress binding for success and every unknown terminal response", async () => {
  const cases: Array<{
    name: string;
    timeoutMs?: number;
    expectedStatus: number;
    cleanupThrows?: boolean;
    commit: (signal: AbortSignal | null | undefined, operationId: string) => Promise<Response>;
  }> = [
    {
      name: "success",
      expectedStatus: 200,
      commit: async (_signal, operationId) =>
        Response.json({ committed: true, operationId }),
    },
    {
      name: "success with cleanup failure",
      expectedStatus: 200,
      cleanupThrows: true,
      commit: async (_signal, operationId) =>
        Response.json({ committed: true, operationId }),
    },
    {
      name: "lost response",
      expectedStatus: 409,
      commit: async () => {
        throw new Error("commit response lost");
      },
    },
    {
      name: "lost response with cleanup failure",
      expectedStatus: 409,
      cleanupThrows: true,
      commit: async () => {
        throw new Error("commit response lost");
      },
    },
    {
      name: "terminal worker failure",
      expectedStatus: 409,
      commit: async () => Response.json(
        { error: { code: "BROWSER_ACTION_OUTCOME_UNKNOWN" } },
        { status: 409 },
      ),
    },
    {
      name: "invalid success response",
      expectedStatus: 409,
      commit: async () => Response.json({ committed: true, operationId: "drifted" }),
    },
    {
      name: "timeout",
      timeoutMs: 5,
      expectedStatus: 409,
      commit: async (signal) => await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    },
  ];

  for (const scenario of cases) {
    const fixture = await createRelayFixture();
    const operationId = `call-close-${scenario.name.replaceAll(" ", "-")}`;
    const sessionId = `browser-session-${scenario.name.replaceAll(" ", "-")}`;
    const generation = 7;
    const egress = new RecordingBrowserEgressRegistry();
    egress.throwOnClose = scenario.cleanupThrows === true;
    let commitCalls = 0;
    const instruction = {
      version: "hosted_browser_relay_instruction_v1",
      operationId,
      operation: "browser.close",
      sessionId,
      generation,
      capability: `private-${operationId}`,
      machine: { appName: "kestrel-env-test", machineId: `machine-${operationId}` },
    };
    const relay = createServer((request, response) => void handleAppRelay({
      request,
      response,
      config: fixture.config,
      requestTimeoutMs: scenario.timeoutMs,
      browserEgress: egress,
      fetchImpl: (async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/accept")) return Response.json({
          ...instruction,
          phase: "accept",
          prepared: { callId: operationId },
          authority: { effectiveAllowlistRevision: "revision-1" },
        });
        if (path.endsWith("/invoke")) {
          return Response.json({ ...instruction, phase: "invoke" });
        }
        return Response.json({
          version: "browser_tool_result_v1",
          operation: "browser.close",
          outcome: "closed",
        });
      }) as typeof fetch,
      browserWorkerFetchImpl: (async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/accept")) return Response.json({
          accepted: true,
          operationId,
          sessionId,
          generation,
          identity: {
            sessionId,
            generation,
            engineRevision: "v0.35.0",
            chromeRevision: "152.0.7977.54",
            imageDigest: `registry.fly.io/browser@sha256:${"a".repeat(64)}`,
          },
        });
        if (path.endsWith("/invoke")) return Response.json({
          version: "browser_tool_result_v1",
          operation: "browser.close",
          outcome: "closed",
        });
        commitCalls += 1;
        return await scenario.commit(init?.signal, operationId);
      }) as typeof fetch,
    }));
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const address = relay.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/close/auto/control`;
    const headers = {
      authorization: `Bearer ${fixture.workspaceToken}`,
      "content-type": "application/json",
    };
    try {
      const accepted = await fetch(`${base}/accept`, {
        method: "POST", headers, body: JSON.stringify({ prepared: { callId: operationId } }),
      });
      assert.equal(accepted.status, 200, scenario.name);
      const dispatchReceipt = await accepted.json();
      const invoked = await fetch(`${base}/invoke`, {
        method: "POST", headers,
        body: JSON.stringify({ prepared: { callId: operationId }, receipt: dispatchReceipt }),
      });
      assert.equal(invoked.status, 200, scenario.name);
      const invocation = await invoked.json() as { commitReceipt: unknown };
      const committed = await fetch(`${base}/commit`, {
        method: "POST", headers,
        body: JSON.stringify({ receipt: invocation.commitReceipt }),
      });
      assert.equal(committed.status, scenario.expectedStatus, scenario.name);
      assert.deepEqual(egress.closed, [{ sessionId, generation }], scenario.name);
      assert.equal(commitCalls, 1, scenario.name);

      const duplicate = await fetch(`${base}/commit`, {
        method: "POST", headers,
        body: JSON.stringify({ receipt: invocation.commitReceipt }),
      });
      assert.equal(duplicate.status, 409, scenario.name);
      assert.deepEqual(egress.closed, [{ sessionId, generation }], scenario.name);
      assert.equal(commitCalls, 1, scenario.name);
    } finally {
      relay.close();
      await egress.closeAll();
      fixture.config.stop();
    }
  }
});

test("stale Browser close invoke and completion cleanup cannot revoke a replacement generation", async () => {
  for (const failurePoint of ["invoke", "complete"] as const) {
    const fixture = await createRelayFixture();
    const operationId = `call-close-stale-${failurePoint}`;
    const sessionId = `browser-session-stale-${failurePoint}`;
    const staleGeneration = 1;
    const replacementGeneration = 2;
    const egress = new ReplacementAwareBrowserEgressRegistry(
      sessionId,
      staleGeneration,
    );
    let workerInvokes = 0;
    let unknownNotifications = 0;
    const instruction = {
      version: "hosted_browser_relay_instruction_v1",
      operationId,
      operation: "browser.close",
      sessionId,
      generation: staleGeneration,
      capability: `private-${operationId}`,
      machine: { appName: "kestrel-env-test", machineId: `machine-${operationId}` },
    };
    const relay = createServer((request, response) => void handleAppRelay({
      request,
      response,
      config: fixture.config,
      browserEgress: egress,
      fetchImpl: (async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/accept")) return Response.json({
          ...instruction,
          phase: "accept",
          prepared: { callId: operationId },
          authority: { effectiveAllowlistRevision: "revision-1" },
        });
        if (path.endsWith("/invoke")) {
          return Response.json({ ...instruction, phase: "invoke" });
        }
        if (path.endsWith("/complete") && failurePoint === "complete") {
          throw new Error("completion response lost");
        }
        if (path.endsWith("/unknown")) unknownNotifications += 1;
        return Response.json({
          version: "browser_tool_result_v1",
          operation: "browser.close",
          outcome: "closed",
        });
      }) as typeof fetch,
      browserWorkerFetchImpl: (async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/accept")) return Response.json({
          accepted: true,
          operationId,
          sessionId,
          generation: staleGeneration,
          identity: {
            sessionId,
            generation: staleGeneration,
            engineRevision: "v0.35.0",
            chromeRevision: "152.0.7977.54",
            imageDigest: `registry.fly.io/browser@sha256:${"a".repeat(64)}`,
          },
        });
        workerInvokes += 1;
        if (failurePoint === "invoke") throw new Error("invoke response lost");
        return Response.json({
          version: "browser_tool_result_v1",
          operation: "browser.close",
          outcome: "closed",
        });
      }) as typeof fetch,
    }));
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const address = relay.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/close/auto/control`;
    const headers = {
      authorization: `Bearer ${fixture.workspaceToken}`,
      "content-type": "application/json",
    };
    try {
      const accepted = await fetch(`${base}/accept`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prepared: { callId: operationId } }),
      });
      assert.equal(accepted.status, 200, failurePoint);
      const receipt = await accepted.json();
      egress.replace(replacementGeneration);

      const invoked = await fetch(`${base}/invoke`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prepared: { callId: operationId },
          receipt,
        }),
      });
      assert.equal(invoked.status, 409, failurePoint);
      assert.equal(
        (await invoked.json() as { error: { code: string } }).error.code,
        "BROWSER_ACTION_OUTCOME_UNKNOWN",
        failurePoint,
      );
      assert.deepEqual(egress.closed, [{
        sessionId,
        generation: staleGeneration,
      }], failurePoint);
      assert.equal(egress.activeGeneration, replacementGeneration, failurePoint);
      assert.equal(workerInvokes, 1, failurePoint);
      assert.equal(unknownNotifications, 1, failurePoint);
    } finally {
      relay.close();
      await egress.closeAll();
      fixture.config.stop();
    }
  }
});

test("Browser close failure before worker acknowledgement does not revoke egress", async () => {
  const fixture = await createRelayFixture();
  const egress = new RecordingBrowserEgressRegistry();
  const relay = createServer((request, response) => void handleAppRelay({
    request,
    response,
    config: fixture.config,
    browserEgress: egress,
    fetchImpl: (async () => Response.json({
      version: "hosted_browser_relay_instruction_v1",
      phase: "accept",
      operationId: "call-close-not-started",
      operation: "browser.close",
      sessionId: "browser-session-not-started",
      generation: 3,
      capability: "private-close-not-started",
      machine: { appName: "kestrel-env-test", machineId: "machine-close-not-started" },
      prepared: { callId: "call-close-not-started" },
      authority: { effectiveAllowlistRevision: "revision-1" },
    })) as typeof fetch,
    browserWorkerFetchImpl: (async () => {
      throw new Error("worker never acknowledged");
    }) as typeof fetch,
  }));
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/apps/built_in.browser/close/auto/control/accept`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.workspaceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prepared: { callId: "call-close-not-started" } }),
      },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(egress.closed, []);
  } finally {
    relay.close();
    await egress.closeAll();
    fixture.config.stop();
  }
});

test("GitHub bundle relay authenticates the Workspace and forwards only the scoped credential", async () => {
  const observed: Array<Record<string, unknown>> = [];
  const controlPlane = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    observed.push({
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      resourceId: request.headers["x-kestrel-resource-id"],
      body: Buffer.concat(chunks).toString("utf8"),
      toolCredentialHeader: request.headers["x-kestrel-tool-credential"],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  controlPlane.listen(0, "127.0.0.1");
  await once(controlPlane, "listening");
  const controlPlaneAddress = controlPlane.address();
  assert.ok(controlPlaneAddress && typeof controlPlaneAddress !== "string");
  const fixture = await createRelayFixture(
    `http://127.0.0.1:${controlPlaneAddress.port}`,
  );
  const relay = createServer((request, response) => {
    void handleAppRelay({ request, response, config: fixture.config });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");

  try {
    const response = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/apps/${fixture.runId}/api/runtime/github/push`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.workspaceToken}`,
          "content-type": "application/x-git-bundle",
          "x-kestrel-tool-credential": "scoped-tool-credential",
          "x-kestrel-resource-id": "resource-1",
        },
        body: "bundle-bytes",
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(observed, [{
      authorization: "Bearer scoped-tool-credential",
      contentType: "application/x-git-bundle",
      resourceId: "resource-1",
      body: "bundle-bytes",
      toolCredentialHeader: undefined,
    }]);
  } finally {
    relay.close();
    controlPlane.close();
    fixture.config.stop();
  }
});

test("app relay times out one stalled upstream request", async () => {
  const fixture = await createRelayFixture();
  let observedSignal: AbortSignal | undefined;
  const relay = createServer((request, response) => {
    void handleAppRelay({
      request,
      response,
      config: fixture.config,
      requestTimeoutMs: 5,
      fetchImpl: (async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }) as typeof fetch,
    });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/apps/${fixture.runId}/api/runtime/email/action`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.workspaceToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 502);
    assert.equal(observedSignal?.aborted, true);
  } finally {
    relay.close();
    fixture.config.stop();
  }
});

test("app relay aborts its upstream request when the downstream closes", async () => {
  const fixture = await createRelayFixture();
  let resolveUpstreamStarted!: () => void;
  const upstreamStarted = new Promise<void>((resolve) => {
    resolveUpstreamStarted = resolve;
  });
  let resolveUpstreamAborted!: () => void;
  const upstreamAborted = new Promise<void>((resolve) => {
    resolveUpstreamAborted = resolve;
  });
  const relay = createServer((request, response) => {
    void handleAppRelay({
      request,
      response,
      config: fixture.config,
      fetchImpl: (async (_input, init) => {
        const signal = init?.signal;
        assert.ok(signal);
        signal.addEventListener("abort", resolveUpstreamAborted, {
          once: true,
        });
        resolveUpstreamStarted();
        return new Promise<Response>(() => {});
      }) as typeof fetch,
    });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");

  try {
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: `/internal/apps/${fixture.runId}/api/runtime/email/action`,
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.workspaceToken}`,
        "content-type": "application/json",
      },
    });
    request.on("error", () => {});
    request.end("{}");
    await upstreamStarted;
    request.destroy();
    await upstreamAborted;
  } finally {
    relay.close();
    fixture.config.stop();
  }
});

class RecordingBrowserEgressRegistry extends HostedBrowserEgressRegistry {
  readonly closed: Array<{ sessionId: string; generation: number }> = [];
  throwOnClose = false;

  constructor() {
    super({
      gatewayMachineId: "gateway-machine-test",
      appName: "kestrel-env-test",
    });
  }

  override require(input: {
    sessionId: string;
    generation: number;
    authority: HostedBrowserGatewayAuthorityV1;
  }): HostedBrowserGatewayProxyBindingV1 {
    return {
      version: "hosted_browser_gateway_proxy_binding_v1",
      proxyServer: "http://gateway-machine-test.vm.kestrel-env-test.internal:43109",
      username: "test-user",
      password: "test-password",
      threadId: "thread-test",
      sessionId: input.sessionId,
      generation: input.generation,
      effectiveAllowlistRevision: input.authority.effectiveAllowlistRevision,
      chromiumFlags: [],
    };
  }

  override async closeExact(input: {
    sessionId: string;
    generation: number;
  }): Promise<boolean> {
    this.closed.push(structuredClone(input));
    if (this.throwOnClose) throw new Error("injected exact cleanup failure");
    return true;
  }
}

class ReplacementAwareBrowserEgressRegistry extends RecordingBrowserEgressRegistry {
  activeGeneration: number;
  readonly #sessionId: string;

  constructor(sessionId: string, generation: number) {
    super();
    this.#sessionId = sessionId;
    this.activeGeneration = generation;
  }

  replace(generation: number): void {
    this.activeGeneration = generation;
  }

  override async closeExact(input: {
    sessionId: string;
    generation: number;
  }): Promise<boolean> {
    this.closed.push(structuredClone(input));
    if (
      input.sessionId !== this.#sessionId ||
      input.generation !== this.activeGeneration
    ) return false;
    this.activeGeneration = 0;
    return true;
  }
}

async function createRelayFixture(
  controlPlaneUrl = "http://127.0.0.1:18081",
) {
  const environmentId = randomUUID();
  const workspaceId = randomUUID();
  const runId = randomUUID();
  const workspaceToken = "workspace-secret";
  const config = new EnvironmentGatewayConfigClient({
    controlPlaneUrl,
    environmentId,
    serviceToken: "gateway-secret",
    fetchImpl: (async () =>
      Response.json({
        version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
        environmentId,
        revision: "relay-timeout-test",
        workspaces: [
          {
            id: workspaceId,
            machineId: "machine-1",
            serviceTokenHash: createHash("sha256")
              .update(workspaceToken)
              .digest("base64url"),
          },
        ],
        previews: [],
        modelGrants: [],
        appGrants: [
          {
            executionId: runId,
            runId: "runtime-run-1",
            workspaceId,
            executionTicket: "execution-ticket",
            credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      })) as typeof fetch,
  });
  await config.refresh();
  return { config, runId, workspaceToken };
}
