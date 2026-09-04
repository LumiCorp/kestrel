import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentBrowserCliAdapter,
  DesktopBrowserService,
} from "../../../../src/localCore/desktopBrowserService.js";
import {
  AgentBrowserHostedWorkerEngine,
  startHostedBrowserWorker,
  type HostedBrowserWorkerConfig,
} from "../../../../src/browser/hostedWorkerServer.js";
import { measureHostedBrowserWorkerRuntime } from "../../../../src/browser/hostedWorkerRuntime.js";

const config = JSON.parse(
  await readFile(process.argv[2]!, "utf8"),
) as HostedBrowserWorkerConfig;
const runtimeRoot = process.argv[3]!;
const certificate = process.argv[4]!;
// Only fixture trust differs from the production engine. All operations,
// dispatch gating, redaction, proxy authority, and Chrome launches are real.
class FixtureTrustAdapter extends AgentBrowserCliAdapter {
  override async open(input: Parameters<AgentBrowserCliAdapter["open"]>[0]) {
    const database = path.join(input.configPath, ".local/share/pki/nssdb");
    await mkdir(database, { recursive: true });
    execFileSync("certutil", [
      "-N",
      "--empty-password",
      "-d",
      `sql:${database}`,
    ]);
    execFileSync("certutil", [
      "-A",
      "-d",
      `sql:${database}`,
      "-n",
      "Browser fixture CA",
      "-t",
      "C,,",
      "-i",
      certificate,
    ]);
    return super.open(input);
  }
}
await measureHostedBrowserWorkerRuntime(config);
const worker = startHostedBrowserWorker({
  config,
  engine: new AgentBrowserHostedWorkerEngine(config, {
    runtimeRoot,
    createDesktopBrowserService: (options) =>
      new DesktopBrowserService({
        ...options,
        engine: new FixtureTrustAdapter(config),
      }),
  }),
});
await once(worker.server, "listening");
process.send?.({
  ready: true,
  port: (worker.server.address() as { port: number }).port,
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(
    signal,
    () =>
      void worker.close().then(
        () => process.exit(0),
        () => process.exit(1),
      ),
  );
}
