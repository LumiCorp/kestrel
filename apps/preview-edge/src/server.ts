import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { readPreviewEdgeConfig } from "./config.js";
import { PreviewEdge } from "./edge.js";
import { PreviewEdgeRouteResolver } from "./route-resolver.js";
import { DesktopPreviewTunnelRegistry } from "./desktop-tunnels.js";
import { WebSocketServer } from "ws";

const RUNTIME_CONTRACT_REVISION = 2;
const SHUTDOWN_DRAIN_MS = 10_000;
const config = readPreviewEdgeConfig();
const resolver = new PreviewEdgeRouteResolver({
  controlPlaneUrl: config.controlPlaneUrl,
  serviceToken: config.serviceToken,
});
const desktopTunnels = new DesktopPreviewTunnelRegistry();
const connectorServer = new WebSocketServer({ noServer: true });
const edge = new PreviewEdge({
  hostSuffix: config.hostSuffix,
  resolver,
  desktopTunnels,
});
const sockets = new Set<Socket>();

const publicServer = createServer((request, response) => {
  void edge.handleHttp(request, response);
});
publicServer.on("upgrade", (request, socket, head) => {
  const match = new URL(
    request.url ?? "/",
    "http://preview.internal",
  ).pathname.match(/^\/internal\/desktop-tunnels\/([0-9a-f-]{36})$/u);
  if (!match?.[1]) {
    void edge.handleUpgrade(request, socket, head);
    return;
  }
  const authorizationHeader = request.headers.authorization;
  void authorizeDesktopTunnel({
    previewId: match[1],
    authorization: authorizationHeader,
  }).then((authorized) => {
    if (!authorized) {
      socket.destroy();
      return;
    }
    connectorServer.handleUpgrade(request, socket, head, (webSocket) => {
      desktopTunnels.attachConnector(match[1]!, webSocket, {
        expiresAtMs: authorized.expiresAtMs,
        revalidate: () =>
          authorizeDesktopTunnel({
            previewId: match[1]!,
            authorization: authorizationHeader,
          }),
      });
    });
  });
});
publicServer.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

const healthServer = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(
    JSON.stringify({
      ok: true,
      service: "preview-edge",
      runtimeContractRevision: RUNTIME_CONTRACT_REVISION,
    }),
  );
});

await Promise.all([
  listen(publicServer, config.port),
  listen(healthServer, config.healthPort),
]);
process.stdout.write(
  `${JSON.stringify({
    type: "preview.edge.started",
    port: config.port,
    healthPort: config.healthPort,
    runtimeContractRevision: RUNTIME_CONTRACT_REVISION,
    occurredAt: new Date().toISOString(),
  })}\n`,
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, SHUTDOWN_DRAIN_MS);
  timer.unref();
  desktopTunnels.close();
  await Promise.all([close(publicServer), close(healthServer)]);
  clearTimeout(timer);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function authorizeDesktopTunnel(input: {
  previewId: string;
  authorization: string | undefined;
}): Promise<{ expiresAtMs: number } | false> {
  const tunnelToken = input.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!tunnelToken) return false;
  try {
    const response = await fetch(
      new URL(
        "/api/runtime/previews/tunnels/authorize",
        config.controlPlaneUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          previewId: input.previewId,
          tunnelToken,
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) return false;
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const expiresAt = (body as { expiresAt?: unknown }).expiresAt;
    if (typeof expiresAt !== "string") return false;
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) {
      return false;
    }
    return { expiresAtMs };
  } catch {
    return false;
  }
}

function close(server: Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
