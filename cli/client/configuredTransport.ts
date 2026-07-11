import { createRequire } from "node:module";

import type { ProtocolTransport } from "./ProtocolClient.js";
import { RemoteRunnerTransport } from "./RemoteRunnerTransport.js";

const configuredTransportRequire = createRequire(import.meta.url);

export function createConfiguredRunnerTransport(): ProtocolTransport {
  const baseUrl = process.env.KESTREL_RUNNER_SERVICE_URL?.trim();
  if (baseUrl !== undefined && baseUrl.length > 0) {
    return new RemoteRunnerTransport({
      baseUrl,
      authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN?.trim(),
    });
  }
  const { RunnerProcess } = configuredTransportRequire("./RunnerProcess.js") as typeof import("./RunnerProcess.js");
  return new RunnerProcess();
}
