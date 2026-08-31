import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  authorizeEnvironmentHttpRequest,
  authorizeEnvironmentRequest,
  authorizeEnvironmentSubscription,
} from "./router.js";
import { proxyWorkspaceRequest } from "./proxy.js";
import { EnvironmentGatewayConfigClient } from "./gateway-config.js";
import { authorizeConfigRefreshToken } from "./config-refresh-auth.js";
import { handleModelRelay } from "./model-relay.js";
import { handleAppRelay } from "./app-relay.js";
import { PreviewRelay } from "./preview-relay.js";
import { handleWorkspaceIdle } from "./workspace-idle.js";
import { handleBrowserRevisionControl } from "./browser-revision.js";
import { handleBrowserViewerControl } from "./browser-viewer.js";
import { handleBrowserUpload } from "./browser-upload.js";
import { handleBrowserDownload } from "./browser-download.js";
import { HostedBrowserEgressRegistry } from "./browser-egress.js";

const ENVIRONMENT_GATEWAY_CONTRACT_REVISION = 3;
const port = readPort(process.env.PORT);
const publicKey = process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "";
const expectedAppName = required(
  process.env.KESTREL_ENVIRONMENT_APP_NAME,
  "KESTREL_ENVIRONMENT_APP_NAME"
);
const environmentId = required(
  process.env.KESTREL_ENVIRONMENT_ID,
  "KESTREL_ENVIRONMENT_ID"
);
const gatewayConfig = new EnvironmentGatewayConfigClient({
  controlPlaneUrl: required(
    process.env.KESTREL_CONTROL_PLANE_URL,
    "KESTREL_CONTROL_PLANE_URL"
  ),
  environmentId,
  serviceToken: required(
    process.env.KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN,
    "KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN"
  ),
});
const browserEgress = new HostedBrowserEgressRegistry({
  gatewayMachineId: required(process.env.FLY_MACHINE_ID, "FLY_MACHINE_ID"),
  appName: expectedAppName,
});
const previewRelay = new PreviewRelay({
  expectedAppName,
  environmentId,
  ticketPublicKey: publicKey,
});
gatewayConfig.subscribe((config) => previewRelay.reconcile(config));
void gatewayConfig.start().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({
      type: "environment.gateway.config.failed",
      environmentId,
      message: error instanceof Error ? error.message : "Configuration failed.",
      occurredAt: new Date().toISOString(),
    })}\n`
  );
});

const server = createServer(async (request, response) => {
  if (await previewRelay.handleHttp(request, response)) return;
  if (previewRelay.isPreviewRequest(request.headers)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "PREVIEW_NOT_FOUND" } }));
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    const gatewayHealth = gatewayConfig.health;
    response.writeHead(gatewayHealth.ready ? 200 : 503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: gatewayHealth.ready,
        service: "environment-router",
        runtimeContractRevision: ENVIRONMENT_GATEWAY_CONTRACT_REVISION,
        configurationReady: gatewayHealth.ready,
        gatewayConfig: gatewayHealth,
      })
    );
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://router.internal").pathname;
  if (request.method === "POST" && pathname === "/internal/config/refresh") {
    try {
      const token = request.headers.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
      if (!token) throw new Error("authorization required");
      authorizeConfigRefreshToken({
        token,
        publicKey,
        environmentId,
        expectedAppName,
      });
    } catch {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "GATEWAY_CONFIG_REFRESH_DENIED" } }));
      return;
    }
    try {
      const refreshed = await gatewayConfig.refreshLatest();
      if (!previewRelay.isReady(refreshed)) {
        response.writeHead(503, {
          "cache-control": "no-store",
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error: { code: "GATEWAY_PREVIEW_RECONCILIATION_FAILED" } }));
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ ok: true, revision: refreshed.revision }));
    } catch {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "GATEWAY_CONFIG_UNAVAILABLE" } }));
    }
    return;
  }
  if (request.method === "POST" && pathname === "/internal/browser/revision") {
    await handleBrowserRevisionControl({
      request,
      response,
      publicKey,
      environmentId,
      expectedAppName,
    });
    return;
  }
  if (request.method === "POST" && pathname === "/internal/browser/viewer") {
    await handleBrowserViewerControl({
      request,
      response,
      publicKey,
      environmentId,
      expectedAppName,
    });
    return;
  }
  if (
    request.method === "POST" &&
    (pathname === "/internal/browser/upload/prepare" ||
      pathname === "/internal/browser/upload/bytes")
  ) {
    await handleBrowserUpload({
      request,
      response,
      publicKey,
      environmentId,
      expectedAppName,
      prepare: pathname.endsWith("/prepare"),
    });
    return;
  }
  if (
    request.method === "POST" &&
    (pathname === "/internal/browser/download/prepare" ||
      pathname === "/internal/browser/download/bytes")
  ) {
    await handleBrowserDownload({
      request,
      response,
      publicKey,
      environmentId,
      expectedAppName,
    });
    return;
  }
  if (pathname.startsWith("/internal/models/")) {
    await handleModelRelay({ request, response, config: gatewayConfig });
    return;
  }
  if (pathname.startsWith("/internal/apps/")) {
    await handleAppRelay({
      request,
      response,
      config: gatewayConfig,
      browserEgress,
    });
    return;
  }
  if (pathname === "/internal/workspaces/idle") {
    await handleWorkspaceIdle({ request, response, config: gatewayConfig });
    return;
  }
  const isCommand = request.method === "POST" && (pathname === "/commands" || pathname === "/commands/stream");
  const isWorkspaceApi = pathname.startsWith("/v1/");
  const isSubscription =
    request.method === "POST" && pathname === "/events/stream";
  if (!(isCommand || isWorkspaceApi || isSubscription)) {
    response.writeHead(404).end();
    return;
  }
  if (isWorkspaceApi) {
    const decision = authorizeEnvironmentHttpRequest({
      authorization: request.headers.authorization,
      pathname,
      method: request.method ?? "GET",
      publicKey,
      expectedAppName,
    });
    await applyDecision(request, response, decision);
    return;
  }
  const body = await readJsonBody(request);
  if (!body.ok) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: body.code } }));
    return;
  }
  const decision = isSubscription
    ? authorizeEnvironmentSubscription({
        authorization: request.headers.authorization,
        body: body.value,
        publicKey,
        expectedAppName,
      })
    : authorizeEnvironmentRequest({
        authorization: request.headers.authorization,
        body: body.value,
        publicKey,
        expectedAppName,
      });
  await applyDecision(request, response, decision, body.raw);
});
server.on("upgrade", (request, socket, head) => {
  if (!previewRelay.handleUpgrade(request, socket, head)) socket.destroy();
});
server.listen(port);

const shutdown = () => {
  gatewayConfig.stop();
  void Promise.allSettled([
    previewRelay.close(),
    browserEgress.closeAll(),
  ]).finally(() => server.close());
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

async function applyDecision(
  request: IncomingMessage,
  response: ServerResponse,
  decision: ReturnType<typeof authorizeEnvironmentRequest>,
  bufferedBody?: Buffer
) {
  if (decision.status !== 200) {
    process.stdout.write(
      `${JSON.stringify({
        type: "environment.router.denied",
        code: decision.code,
        status: decision.status,
        occurredAt: new Date().toISOString(),
      })}\n`
    );
    response.writeHead(decision.status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: decision.code } }));
    return;
  }
  await proxyWorkspaceRequest({
    request,
    response,
    targetUrl: decision.targetUrl,
    bufferedBody,
    correlation: {
      organizationId: decision.ticket.organizationId,
      environmentId: decision.ticket.environmentId,
      workspaceId: decision.ticket.workspaceId,
      threadId: decision.ticket.threadId,
      executionId: decision.ticket.runId,
    },
  });
}

async function readJsonBody(request: NodeJS.ReadableStream): Promise<
  | { ok: true; value: unknown; raw: Buffer }
  | { ok: false; code: string }
> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 2_000_000) return { ok: false, code: "REQUEST_TOO_LARGE" };
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  try {
    return { ok: true, value: JSON.parse(raw.toString("utf8")), raw };
  } catch {
    return { ok: false, code: "REQUEST_JSON_INVALID" };
  }
}

function readPort(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "8080", 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  return parsed;
}

function required(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
