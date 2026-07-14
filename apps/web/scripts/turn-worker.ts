import {
  startDurableThreadTurnWorker,
  stopDurableThreadTurnWorker,
} from "@/lib/turns/queue";

await startDurableThreadTurnWorker();
process.stdout.write("Kestrel One durable turn worker started.\n");

async function shutdown(signal: string) {
  process.stdout.write(`Kestrel One durable turn worker received ${signal}.\n`);
  await stopDurableThreadTurnWorker();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
