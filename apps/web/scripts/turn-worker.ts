import {
  startDurableThreadTurnWorker,
  stopDurableThreadTurnWorker,
} from "@/lib/turns/queue";
import { getGatewayCredentialAuthorityReadiness } from "@/lib/ai/gateway-credential-readiness.server";
import { rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { and, eq } from "drizzle-orm";
import {
  assertTurnWorkerProcessConfiguration,
  PROCESS_CONFIGURATION_CONTRACT_REVISION,
  TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
} from "@/lib/runtime/process-contracts";

const readyFile = process.env.KESTREL_TURN_WORKER_READY_FILE;
const machineId = process.env.FLY_MACHINE_ID?.trim() ?? null;
const processStartedAt = new Date();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function sourceRevision() {
  const value = (
    await readFile("/workspace/.kestrel-source-revision", "utf8")
  ).trim();
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error("Turn-worker source revision artifact is invalid.");
  }
  return value;
}

async function heartbeat(revision: string) {
  if (!machineId) return;
  const now = new Date();
  await knowledgeDb
    .insert(schema.platformWorkerHeartbeats)
    .values({
      workerRole: "turn-worker",
      machineId,
      sourceRevision: revision,
      configurationFingerprint: TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
      contractRevision: PROCESS_CONFIGURATION_CONTRACT_REVISION,
      processStartedAt,
      heartbeatAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.platformWorkerHeartbeats.workerRole,
        schema.platformWorkerHeartbeats.machineId,
      ],
      set: {
        sourceRevision: revision,
        configurationFingerprint:
          TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
        contractRevision: PROCESS_CONFIGURATION_CONTRACT_REVISION,
        processStartedAt,
        heartbeatAt: now,
      },
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
  if (process.env.NODE_ENV === "production" || machineId) {
    assertTurnWorkerProcessConfiguration();
  } else if (!(process.env.POSTGRES_URL || process.env.DATABASE_URL)) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }
  const revision = machineId ? await sourceRevision() : null;
  const gatewayCredentialReadiness =
    await getGatewayCredentialAuthorityReadiness();
  if (!gatewayCredentialReadiness.ok) {
    throw new Error(
      `Gateway credential readiness failed: ${gatewayCredentialReadiness.code}`,
    );
  }
  await startDurableThreadTurnWorker();
  if (revision) await heartbeat(revision);
  heartbeatTimer = revision
    ? setInterval(() => {
        void heartbeat(revision).catch((error: unknown) => {
          process.stderr.write(
            `Turn-worker heartbeat failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
          );
        });
      }, 30_000)
    : null;
  await markReady();
  process.stdout.write("Kestrel One durable turn worker started.\n");
}

async function shutdown(signal: string) {
  process.stdout.write(`Kestrel One durable turn worker received ${signal}.\n`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await stopDurableThreadTurnWorker();
  if (machineId)
    await knowledgeDb
      .delete(schema.platformWorkerHeartbeats)
      .where(
        and(
          eq(schema.platformWorkerHeartbeats.workerRole, "turn-worker"),
          eq(schema.platformWorkerHeartbeats.machineId, machineId),
          eq(
            schema.platformWorkerHeartbeats.processStartedAt,
            processStartedAt,
          ),
        ),
      )
      .catch(() => {});
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
