import { getGatewayCredentialAuthorityReadiness } from "@/lib/ai/gateway-credential-readiness.server";
import {
  assertTurnWorkerProcessConfiguration,
  TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
} from "@/lib/runtime/process-contracts";
import {
  assertWorkerDatabaseReady,
  resolveWorkerSourceRevision,
  startWorkerHealthServer,
} from "@/lib/runtime/worker-health";
import {
  startDurableThreadTurnWorker,
  stopDurableThreadTurnWorker,
} from "@/lib/turns/queue";

let health: Awaited<ReturnType<typeof startWorkerHealthServer>> | null = null;

async function main() {
  if (process.env.NODE_ENV === "production" || process.env.FLY_MACHINE_ID) {
    assertTurnWorkerProcessConfiguration();
  } else if (!(process.env.POSTGRES_URL || process.env.DATABASE_URL)) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }
  health = await startWorkerHealthServer({
    role: "turn-worker",
    sourceRevision: await resolveWorkerSourceRevision(),
    configurationFingerprint: TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  });
  await assertWorkerDatabaseReady();
  const readiness = await getGatewayCredentialAuthorityReadiness();
  if (!readiness.ok) {
    throw new Error(`Gateway credential readiness failed: ${readiness.code}`);
  }
  await startDurableThreadTurnWorker();
  health.markReady();
  process.stdout.write("Kestrel One durable turn worker started.\n");
}

async function shutdown(signal: string) {
  process.stdout.write(`Kestrel One durable turn worker received ${signal}.\n`);
  health?.markUnhealthy();
  await stopDurableThreadTurnWorker();
  await health?.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void main().catch(async (error: unknown) => {
  health?.markUnhealthy();
  await health?.close().catch(() => {});
  process.stderr.write(
    `Kestrel One durable turn worker failed to start: ${
      error instanceof Error ? error.message : "Unknown startup error"
    }\n`,
  );
  process.exit(1);
});
