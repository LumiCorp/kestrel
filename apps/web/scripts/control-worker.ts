import {
  startEnvironmentLifecycleWorker,
  stopEnvironmentLifecycleWorker,
} from "@/lib/knowledge/queue";
import { rm, writeFile } from "node:fs/promises";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { assertHostedEnvironmentConfiguration } from "@/lib/environments/config";
import { RELEASE_CONTROLLER_CONTRACT_REVISION } from "@/lib/releases/controller-contract";

const readyFile = process.env.KESTREL_CONTROL_WORKER_READY_FILE;
const startedAt = new Date();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function heartbeat() {
  const now = new Date();
  const sourceRevision = process.env.KESTREL_BUILD_REVISION?.trim();
  const image =
    process.env.KESTREL_RELEASE_IMAGE?.trim() ||
    process.env.FLY_IMAGE_REF?.trim();
  const inputFingerprint =
    process.env.KESTREL_CONTROL_WORKER_FINGERPRINT?.trim();
  const machineId = process.env.FLY_MACHINE_ID?.trim();
  if (!(sourceRevision && image && inputFingerprint && machineId)) {
    throw new Error("Release controller runtime identity is incomplete.");
  }
  await knowledgeDb
    .insert(schema.releaseControllerHeartbeats)
    .values({
      id: "platform",
      contractRevision: RELEASE_CONTROLLER_CONTRACT_REVISION,
      sourceRevision,
      image,
      inputFingerprint,
      machineId,
      heartbeatAt: now,
      startedAt,
    })
    .onConflictDoUpdate({
      target: schema.releaseControllerHeartbeats.id,
      set: {
        contractRevision: RELEASE_CONTROLLER_CONTRACT_REVISION,
        sourceRevision,
        image,
        inputFingerprint,
        machineId,
        heartbeatAt: now,
        startedAt,
      },
    });
}

async function markReady() {
  if (readyFile) {
    await writeFile(
      readyFile,
      `release-controller-v${RELEASE_CONTROLLER_CONTRACT_REVISION}\n`,
      "utf8",
    );
  }
}

async function clearReady() {
  if (readyFile) await rm(readyFile, { force: true });
}

async function main() {
  assertHostedEnvironmentConfiguration();
  await startEnvironmentLifecycleWorker();
  await heartbeat();
  heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error: unknown) => {
      process.stderr.write(
        `Release controller heartbeat failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
      );
    });
  }, 30_000);
  await markReady();
  process.stdout.write(
    `Kestrel One control worker started (release-controller-v${RELEASE_CONTROLLER_CONTRACT_REVISION}).\n`,
  );
}

async function shutdown(signal: string) {
  process.stdout.write(`Kestrel One control worker received ${signal}.\n`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await stopEnvironmentLifecycleWorker();
  await clearReady();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void main().catch((error: unknown) => {
  void clearReady();
  process.stderr.write(
    `Kestrel One control worker failed to start: ${
      error instanceof Error ? error.message : "Unknown startup error"
    }\n`,
  );
  process.exit(1);
});
