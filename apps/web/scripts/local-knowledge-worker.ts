import { startKnowledgeDocumentWorker, stopControlWorkers } from "@/lib/knowledge/queue";
import {
  assertWorkerDatabaseReady,
  resolveWorkerBuildId,
  startWorkerHealthServer,
} from "@/lib/runtime/worker-health";

let health: Awaited<ReturnType<typeof startWorkerHealthServer>> | null = null;

async function main() {
  if (!(process.env.POSTGRES_URL || process.env.DATABASE_URL)) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }
  health = await startWorkerHealthServer({
    role: "knowledge-worker",
    buildId: await resolveWorkerBuildId(),
  });
  await assertWorkerDatabaseReady();
  await startKnowledgeDocumentWorker();
  health.markReady();
  process.stdout.write("Kestrel One local Knowledge worker started.\n");
}

async function shutdown(signal: string) {
  process.stdout.write(`Kestrel One local Knowledge worker received ${signal}.\n`);
  health?.markUnhealthy();
  await stopControlWorkers();
  await health?.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void main().catch(async (error: unknown) => {
  health?.markUnhealthy();
  await stopControlWorkers().catch(() => {});
  await health?.close().catch(() => {});
  process.stderr.write(
    `Kestrel One local Knowledge worker failed to start: ${
      error instanceof Error ? error.message : "Unknown startup error"
    }\n`,
  );
  process.exit(1);
});
