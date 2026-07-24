import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { readPreviewEdgeConfig } from "./config.js";
import { PreviewEdge } from "./edge.js";
import { PreviewEdgeRouteResolver } from "./route-resolver.js";

const RUNTIME_CONTRACT_REVISION = 1;
const SHUTDOWN_DRAIN_MS = 10_000;
const config = readPreviewEdgeConfig();
const resolver = new PreviewEdgeRouteResolver({
  controlPlaneUrl: config.controlPlaneUrl,
  serviceToken: config.serviceToken,
});
const edge = new PreviewEdge({
  hostSuffix: config.hostSuffix,
  resolver,
});
const sockets = new Set<Socket>();

const publicServer = createServer((request, response) => {
  void edge.handleHttp(request, response);
});
publicServer.on("upgrade", (request, socket, head) => {
  void edge.handleUpgrade(request, socket, head);
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
    })
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
  })}\n`
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, SHUTDOWN_DRAIN_MS);
  timer.unref();
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

function close(server: Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
