import { startManagedRunPodWorker } from "@/lib/knowledge/queue";
import {
  assertRunPodWorkerProcessConfiguration,
  RUNPOD_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
} from "@/lib/runtime/process-contracts";
import {
  assertWorkerDatabaseReady,
  resolveWorkerSourceRevision,
  startWorkerHealthServer,
} from "@/lib/runtime/worker-health";

async function run() {
  assertRunPodWorkerProcessConfiguration();
  const health = await startWorkerHealthServer({
    role: "runpod-worker",
    sourceRevision: await resolveWorkerSourceRevision(),
    configurationFingerprint: RUNPOD_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  });
  try {
    await assertWorkerDatabaseReady();
    const boss = await startManagedRunPodWorker();
    health.markReady();
    process.stdout.write("Kestrel One managed RunPod worker started.\n");

    async function shutdown(signal: string) {
      process.stdout.write(
        `Kestrel One managed RunPod worker received ${signal}.\n`,
      );
      health.markUnhealthy();
      await boss.stop({ graceful: true, timeout: 30_000 });
      await health.close();
      process.exit(0);
    }

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    health.markUnhealthy();
    await health.close().catch(() => {});
    throw error;
  }
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
