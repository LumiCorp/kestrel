import {
  startDurableThreadTurnWorker,
  stopDurableThreadTurnWorker,
} from "@/lib/turns/queue";
import { rm, writeFile } from "node:fs/promises";

const readyFile = process.env.KESTREL_TURN_WORKER_READY_FILE;

async function markReady() {
  if (readyFile) {
    await writeFile(readyFile, "ready\n", "utf8");
  }
}

async function clearReady() {
  if (readyFile) {
    await rm(readyFile, { force: true });
  }
}

async function main() {
  await startDurableThreadTurnWorker();
  await markReady();
  process.stdout.write("Kestrel One durable turn worker started.\n");
}

async function shutdown(signal: string) {
  process.stdout.write(`Kestrel One durable turn worker received ${signal}.\n`);
  await stopDurableThreadTurnWorker();
  await clearReady();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void main().catch((error: unknown) => {
  void clearReady();
  process.stderr.write(
    `Kestrel One durable turn worker failed to start: ${
      error instanceof Error ? error.message : "Unknown startup error"
    }\n`
  );
  process.exit(1);
});
