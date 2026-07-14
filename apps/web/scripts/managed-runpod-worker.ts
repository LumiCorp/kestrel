import { startManagedRunPodWorker } from "@/lib/knowledge/queue";

async function run() {
  const boss = await startManagedRunPodWorker();
  process.stdout.write("Kestrel One managed RunPod worker started.\n");

  async function shutdown(signal: string) {
    process.stdout.write(
      `Kestrel One managed RunPod worker received ${signal}.\n`
    );
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exit(1);
});
