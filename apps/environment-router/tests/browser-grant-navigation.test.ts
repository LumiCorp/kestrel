import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { ENVIRONMENT_GATEWAY_CONFIG_VERSION } from "@lumi/kestrel-environment-auth";
import { handleAppRelay, isAllowedAppRequest } from "../src/app-relay.js";
import {
  HostedBrowserEgressRegistry,
  type HostedBrowserGatewayAuthorityV1,
} from "../src/browser-egress.js";
import { EnvironmentGatewayConfigClient } from "../src/gateway-config.js";

test("Browser transfer preparation and release routes are scoped to their exact capability", () => {
  for (const [capability, action] of [
    ["upload", "prepare-upload"],
    ["download", "prepare-download"],
    ["download", "release-download"],
  ]) {
    for (const mode of ["auto", "confirmed"]) {
      const route = `/api/runtime/apps/built_in.browser/${capability}/${mode}/control/${action}`;
      assert.equal(isAllowedAppRequest(route, "POST"), true, route);
      assert.equal(isAllowedAppRequest(route, "GET"), false);
      assert.equal(
        isAllowedAppRequest(
          route.replace(`/${capability}/`, "/snapshot/"),
          "POST",
        ),
        false,
      );
    }
  }
  for (const action of [
    "startup-failed",
    "complete",
    "unknown",
    "adopt-complete",
    "prepare-anything",
  ]) {
    assert.equal(
      isAllowedAppRequest(
        `/api/runtime/apps/built_in.browser/upload/auto/control/${action}`,
        "POST",
      ),
      false,
    );
  }
});

// A fast relay regression, not Chrome or Web service proof. Unlike the old
// grant fixture, this keeps the actual revision-enforcing egress registry.
for (const beforeDispatch of [true, false]) {
  test(`grant completion adopts the real Gateway before navigation (${beforeDispatch ? "pre-dispatch" : "dispatched"})`, async () => {
    const environmentId = randomUUID();
    const workspaceId = randomUUID();
    const runId = randomUUID();
    const workspaceToken = "local-grant-test-only";
    const config = new EnvironmentGatewayConfigClient({
      controlPlaneUrl: "http://127.0.0.1:18081",
      environmentId,
      serviceToken: "test",
      fetchImpl: async () =>
        Response.json({
          version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
          environmentId,
          revision: "test",
          workspaces: [
            {
              id: workspaceId,
              machineId: "workspace",
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
              runId: "runtime-run",
              workspaceId,
              executionTicket: "test",
              credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        }),
    });
    await config.refresh();
    const registry = new HostedBrowserEgressRegistry({
      gatewayMachineId: "gateway",
      appName: "browser-test",
    });
    const identity = { sessionId: randomUUID(), generation: 1 };
    const domain = (canonicalDomain: string) => ({
      version: "browser_public_domain_authority_v1" as const,
      scheme: "https" as const,
      canonicalDomain,
      includeSubdomains: true as const,
      port: 443 as const,
    });
    const oldAuthority: HostedBrowserGatewayAuthorityV1 = {
      version: "browser_effective_domain_authority_v1",
      environmentId,
      projectId: "project",
      userId: "user",
      enabledModes: ["operator"],
      publicDomains: [domain("example.com")],
      qaTarget: null,
      effectiveAllowlistRevision: "before",
    };
    const authority = {
      ...oldAuthority,
      publicDomains: [...oldAuthority.publicDomains, domain("example.net")],
      effectiveAllowlistRevision: "after",
    };
    await registry.install({
      ...identity,
      threadId: "thread",
      mode: "operator",
      authority: oldAuthority,
      hardExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const output = {
      version: "browser_tool_result_v1",
      operation: "browser.request_grant",
      outcome: "already_allowed",
      sessionId: identity.sessionId,
      effectiveAllowlistRevision: "after",
    };
    const instruction = (callId: string, phase: string) => ({
      version: "hosted_browser_relay_instruction_v1",
      phase,
      operationId: callId,
      operation:
        callId === "grant" ? "browser.request_grant" : "browser.navigate",
      ...identity,
      capability: "test",
      machine: { appName: "browser-test", machineId: "worker" },
      prepared: { callId },
      authority,
    });
    let navigationAccepts = 0;
    const relay = createServer(
      (request, response) =>
        void handleAppRelay({
          request,
          response,
          config,
          browserEgress: registry,
          fetchImpl: async (url, init) => {
            const action = new URL(String(url)).pathname.split("/").at(-1);
            const body = JSON.parse(String(init?.body));
            return Response.json(
              action === "complete"
                ? output
                : instruction(
                    body.prepared.callId,
                    action === "accept" ? "accept" : "invoke",
                  ),
            );
          },
          browserWorkerFetchImpl: async (url, init) => {
            const action = new URL(String(url)).pathname.split("/").at(-1);
            const body = JSON.parse(String(init?.body));
            if (action === "commit")
              return Response.json({
                committed: true,
                operationId: body.operationId,
              });
            if (action === "invoke") return Response.json(output);
            const callId = body.prepared.callId;
            if (callId !== "grant") navigationAccepts++;
            return Response.json({
              ...(callId === "grant" && beforeDispatch
                ? { completedBeforeDispatch: true, output }
                : { accepted: true }),
              operationId: callId,
              ...identity,
              identity: {
                ...identity,
                engineRevision: "v0.35.0-kestrel.1",
                chromeRevision: "152.0.7977.54",
                imageDigest: `registry.fly.io/browser@sha256:${"a".repeat(64)}`,
              },
            });
          },
        }),
    );
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const address = relay.address();
    assert.ok(address && typeof address !== "string");
    const post = (operation: string, action: string, body: unknown) =>
      fetch(
        `http://127.0.0.1:${address.port}/internal/apps/${runId}/api/runtime/apps/built_in.browser/${operation}/auto/control/${action}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${workspaceToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    try {
      const accepted = await post("request_grant", "accept", {
        prepared: { callId: "grant" },
      });
      assert.equal(accepted.status, 200);
      const receipt = await accepted.json();
      const completed = beforeDispatch
        ? receipt
        : await (
            await post("request_grant", "invoke", {
              prepared: { callId: "grant" },
              receipt,
            })
          ).json();
      assert.deepEqual(completed.output, output);
      assert.equal(
        (
          await post("request_grant", "commit", {
            receipt: completed.commitReceipt,
          })
        ).status,
        200,
      );
      const navigation = await post("navigate", "accept", {
        prepared: { callId: "navigation" },
      });
      assert.equal(
        navigation.status,
        200,
        "grant success must allow the next same-session navigation to reach the worker",
      );
      assert.equal(navigationAccepts, 1);
      assert.equal(
        registry.require({ ...identity, authority }).effectiveAllowlistRevision,
        "after",
      );
    } finally {
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await registry.closeAll();
      config.stop();
    }
  });
}
