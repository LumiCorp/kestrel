import { startManagedRunPodWorker } from "@/lib/knowledge/queue";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

const startedAt = new Date();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function heartbeat() {
  const sourceRevision = process.env.KESTREL_BUILD_REVISION?.trim();
  const image =
    process.env.KESTREL_RELEASE_IMAGE?.trim() ||
    process.env.FLY_IMAGE_REF?.trim();
  const machineId = process.env.FLY_MACHINE_ID?.trim();
  if (!(sourceRevision && image && machineId)) {
    throw new Error("RunPod worker runtime identity is incomplete.");
  }
  const now = new Date();
  await knowledgeDb
    .insert(schema.releaseWorkerHeartbeats)
    .values({
      role: "runpod-worker",
      sourceRevision,
      image,
      machineId,
      startedAt,
      heartbeatAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.releaseWorkerHeartbeats.role,
        schema.releaseWorkerHeartbeats.machineId,
      ],
      set: { sourceRevision, image, startedAt, heartbeatAt: now },
    });
}

async function run() {
  const boss = await startManagedRunPodWorker();
  await heartbeat();
  heartbeatTimer = setInterval(
    () =>
      void heartbeat().catch((error) => {
        process.stderr.write(
          `RunPod worker heartbeat failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
        );
      }),
    30_000,
  );
  process.stdout.write("Kestrel One managed RunPod worker started.\n");

  async function shutdown(signal: string) {
    process.stdout.write(
      `Kestrel One managed RunPod worker received ${signal}.\n`,
    );
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
