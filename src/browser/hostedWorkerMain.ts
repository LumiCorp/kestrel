import {
  hostedBrowserWorkerConfigFromEnv,
  startHostedBrowserWorker,
} from "./hostedWorkerServer.js";
import { measureHostedBrowserWorkerRuntime } from "./hostedWorkerRuntime.js";

const config = hostedBrowserWorkerConfigFromEnv();
const measurement = await measureHostedBrowserWorkerRuntime({
  engineExecutablePath: config.engineExecutablePath,
  chromeExecutablePath: config.chromeExecutablePath,
});
const worker = startHostedBrowserWorker({
  config: { ...config, ...measurement },
  onControlLoss() {
    setImmediate(() => process.exit(1));
  },
});

async function shutdown() {
  await worker.close().catch(() => {});
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
