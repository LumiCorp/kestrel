import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { readConnectorConfig } from "./config.js";
import { ControlPlaneClient } from "./control-plane-client.js";
import { ConnectorIdentityStore } from "./identity.js";
import { KubernetesClient } from "./kubernetes-client.js";
import { runNetworkProbe, runNetworkProbeServer, runQualificationProbe } from "./probe.js";
import { connectorLog } from "./redaction.js";
import { ConnectorRuntime } from "./runtime.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === "qualification-probe") {
    await runQualificationProbe();
  } else if (mode === "network-probe") {
    await runNetworkProbe();
  } else if (mode === "network-probe-server") {
    await runNetworkProbeServer();
  } else {
    await runConnectorServer();
  }
}

export async function runConnectorServer() {
  const config = readConnectorConfig();
  const kubernetes = await KubernetesClient.inCluster(config);
  const identities = new ConnectorIdentityStore(kubernetes, config);
  const controlPlane = new ControlPlaneClient(config);
  const runtime = new ConnectorRuntime(
    config,
    kubernetes,
    identities,
    controlPlane,
  );
  const server = createHealthServer(() => runtime.isReady());
  server.listen(config.port, "0.0.0.0");
  const shutdown = (signal: string) => {
    connectorLog("info", "connector.shutdown", { signal });
    runtime.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  await runtime.run();
}

export function createHealthServer(isReady: () => boolean) {
  return createServer((request, response) => {
    if (request.url === "/health/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ live: true }));
      return;
    }
    if (request.url === "/health/ready") {
      response.writeHead(isReady() ? 200 : 503, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ ready: isReady() }));
      return;
    }
    response.writeHead(404).end();
  });
}
