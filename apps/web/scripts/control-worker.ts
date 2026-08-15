import {
  startEnvironmentLifecycleWorker,
  stopEnvironmentLifecycleWorker,
} from "@/lib/knowledge/queue";
import {
  assertControlWorkerProcessConfiguration,
  CONTROL_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
} from "@/lib/runtime/process-contracts";
import {
  assertWorkerDatabaseReady,
  resolveWorkerSourceRevision,
  startWorkerHealthServer,
} from "@/lib/runtime/worker-health";

let health: Awaited<ReturnType<typeof startWorkerHealthServer>> | null = null;

async function main() {
  assertControlWorkerProcessConfiguration();
  health = await startWorkerHealthServer({
    role: "control-worker",
    sourceRevision: await resolveWorkerSourceRevision(),
    configurationFingerprint: CONTROL_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  });
  await assertWorkerDatabaseReady();
  await startEnvironmentLifecycleWorker();
  health.markReady();
  process.stdout.write("Kestrel One Environment lifecycle worker started.\n");
}

async function shutdown(signal: string) {
  process.stdout.write(`Kestrel One Environment lifecycle worker received ${signal}.\n`);
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
    `Kestrel One Environment lifecycle worker failed to start: ${
      error instanceof Error ? error.message : "Unknown startup error"
    }\n`,
  );
  process.exit(1);
});
