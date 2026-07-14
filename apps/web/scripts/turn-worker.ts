import {
  startDurableThreadTurnWorker,
  stopDurableThreadTurnWorker,
} from "@/lib/turns/queue";

async function main() {
  await startDurableThreadTurnWorker();
  process.stdout.write("Kestrel One durable turn worker started.\n");
}

async function shutdown(signal: string) {
  process.stdout.write(`Kestrel One durable turn worker received ${signal}.\n`);
  await stopDurableThreadTurnWorker();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void main().catch((error: unknown) => {
  process.stderr.write(
    `Kestrel One durable turn worker failed to start: ${
      error instanceof Error ? error.message : "Unknown startup error"
    }\n`
  );
  process.exit(1);
});
