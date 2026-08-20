import {
  startEnvironmentLifecycleWorker,
  stopEnvironmentLifecycleWorker,
} from "@/lib/knowledge/queue";
import {
  assertControlWorkerProcessConfiguration,
} from "@/lib/runtime/process-contracts";
import {
  assertWorkerDatabaseReady,
  resolveWorkerBuildId,
  startWorkerHealthServer,
} from "@/lib/runtime/worker-health";

let health: Awaited<ReturnType<typeof startWorkerHealthServer>> | null = null;

async function main() {
  assertControlWorkerProcessConfiguration();
  health = await startWorkerHealthServer({
    role: "control-worker",
    buildId: await resolveWorkerBuildId(),
  });
  await assertWorkerDatabaseReady();
  await startEnvironmentLifecycleWorker();
  health.markReady();
  process.stdout.write("Kestrel One Control Worker started.\n");
}

async function shutdown(signal: string) {
  process.stdout.write(`Kestrel One Control Worker received ${signal}.\n`);
  health?.markUnhealthy();
  await stopEnvironmentLifecycleWorker();
  await health?.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void main().catch(async (error: unknown) => {
  health?.markUnhealthy();
  await health?.close().catch(() => {});
  process.stderr.write(
    `Kestrel One Control Worker failed to start: ${
      error instanceof Error ? error.message : "Unknown startup error"
    }\n`,
  );
  process.exit(1);
});
