import {
  startDurableThreadTurnWorker,
  stopDurableThreadTurnWorker,
} from "@/lib/turns/queue";
import { getGatewayCredentialAuthorityReadiness } from "@/lib/ai/gateway-credential-readiness.server";
import { rm, writeFile } from "node:fs/promises";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

const readyFile = process.env.KESTREL_TURN_WORKER_READY_FILE;
const startedAt = new Date();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function heartbeat() {
  const sourceRevision = process.env.KESTREL_BUILD_REVISION?.trim();
  const image =
    process.env.KESTREL_RELEASE_IMAGE?.trim() ||
    process.env.FLY_IMAGE_REF?.trim();
  const machineId = process.env.FLY_MACHINE_ID?.trim();
  if (!(sourceRevision && image && machineId)) {
    throw new Error("Turn worker runtime identity is incomplete.");
  }
  const now = new Date();
  await knowledgeDb
    .insert(schema.releaseWorkerHeartbeats)
    .values({
      role: "turn-worker",
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
  if (!(process.env.POSTGRES_URL || process.env.DATABASE_URL)) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }
  const gatewayCredentialReadiness =
    await getGatewayCredentialAuthorityReadiness();
  if (!gatewayCredentialReadiness.ok) {
    throw new Error(
      `Gateway credential readiness failed: ${gatewayCredentialReadiness.code}`,
    );
  }
  await startDurableThreadTurnWorker();
  await heartbeat();
  heartbeatTimer = setInterval(
    () =>
      void heartbeat().catch((error) => {
        process.stderr.write(
          `Turn worker heartbeat failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
        );
      }),
    30_000,
  );
  await markReady();
  process.stdout.write("Kestrel One durable turn worker started.\n");
}

async function shutdown(signal: string) {
  process.stdout.write(`Kestrel One durable turn worker received ${signal}.\n`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
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
    }\n`,
  );
  process.exit(1);
});
