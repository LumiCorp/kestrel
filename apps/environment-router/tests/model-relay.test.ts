import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { ENVIRONMENT_GATEWAY_CONFIG_VERSION } from "@lumi/kestrel-environment-auth";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import { EnvironmentGatewayConfigClient } from "../src/gateway-config.js";
import { handleModelRelay } from "../src/model-relay.js";

contractTest("services.process", "model relay enforces workspace run and model while keeping provider credentials at the gateway", async () => {
  const upstreamRequests: Array<{
    path: string | undefined;
    authorization: string | undefined;
    apiKey: string | undefined;
    body: unknown;
  }> = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    upstreamRequests.push({
      path: request.url,
      authorization: request.headers.authorization,
      apiKey: typeof request.headers["x-api-key"] === "string"
        ? request.headers["x-api-key"]
        : undefined,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    response.end("data: second\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

  const environmentId = randomUUID();
  const workspaceId = randomUUID();
  const runId = randomUUID();
  const anthropicRunId = randomUUID();
  const workspaceToken = "workspace-only-secret";
  let configuredWorkspaceToken = workspaceToken;
  const config = new EnvironmentGatewayConfigClient({
    controlPlaneUrl: "http://127.0.0.1:9999",
    environmentId,
    serviceToken: "gateway-secret",
    fetchImpl: async () => Response.json({
      version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
      environmentId,
      revision: new Date().toISOString(),
      ngrok: null,
      workspaces: [{
        id: workspaceId,
        machineId: "machine-1",
        serviceTokenHash: createHash("sha256").update(configuredWorkspaceToken).digest("base64url"),
      }],
      previews: [],
      modelGrants: [
        {
          runId,
          workspaceId,
          gatewayId: randomUUID(),
          rawModelId: "gpt-approved",
          provider: "openai",
          protocol: "openai",
          baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
          apiKey: "provider-secret",
          credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        {
          runId: anthropicRunId,
          workspaceId,
          gatewayId: randomUUID(),
          rawModelId: "claude-approved",
          provider: "lumi",
          protocol: "anthropic",
          baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
          apiKey: "lumi-provider-secret",
          credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }),
  });
  await config.refresh();
  const relay = createServer((request, response) => {
    void handleModelRelay({ request, response, config });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/models/${runId}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${workspaceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-approved", input: "hello" }),
      }
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
    assert.deepEqual(upstreamRequests, [{
      path: "/v1/responses",
      authorization: "Bearer provider-secret",
      apiKey: undefined,
      body: { model: "gpt-approved", input: "hello" },
    }]);

    const anthropic = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/models/${anthropicRunId}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": workspaceToken,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "claude-approved", messages: [] }),
      }
    );
    assert.equal(anthropic.status, 200);
    assert.equal(await anthropic.text(), "data: first\n\ndata: second\n\n");
    assert.deepEqual(upstreamRequests[1], {
      path: "/v1/messages",
      authorization: undefined,
      apiKey: "lumi-provider-secret",
      body: { model: "claude-approved", messages: [] },
    });

    const denied = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/models/${runId}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${workspaceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-unapproved", input: "hello" }),
      }
    );
    assert.equal(denied.status, 403);
    assert.equal(upstreamRequests.length, 2);

    configuredWorkspaceToken = "rotated-workspace-secret";
    const afterRotation = await fetch(
      `http://127.0.0.1:${relayAddress.port}/internal/models/${runId}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${configuredWorkspaceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-approved", input: "after rotation" }),
      }
    );
    assert.equal(afterRotation.status, 200);
    assert.equal(await afterRotation.text(), "data: first\n\ndata: second\n\n");
    assert.equal(upstreamRequests.length, 3);
  } finally {
    relay.close();
    upstream.close();
    config.stop();
  }
});
