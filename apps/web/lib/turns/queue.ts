import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export const DURABLE_THREAD_TURN_QUEUE = "thread.turn.execute";

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
let bossPromise: Promise<PgBoss> | null = null;
let workerRegistered = false;
let pushTimer: ReturnType<typeof setInterval> | null = null;

async function drainMobilePushOutbox() {
  const {
    dispatchPendingMobilePushNotifications,
    reconcileMobilePushReceipts,
    syncPendingMobileInteractions,
  } = await import("@/lib/mobile/push");
  await syncPendingMobileInteractions();
  await dispatchPendingMobilePushNotifications();
  await reconcileMobilePushReceipts();
}

function reportPushFailure(error: unknown) {
  console.error("Kestrel One mobile push delivery failed.", {
    message: error instanceof Error ? error.message : "Unknown push error",
  });
}

async function createTurnBoss() {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }
  const boss = new PgBoss({ connectionString: databaseUrl, migrate: true });
  await boss.start();
  await boss.createQueue(DURABLE_THREAD_TURN_QUEUE);
  return boss;
}

async function getTurnBoss() {
  bossPromise ??= createTurnBoss();
  return bossPromise;
}

async function sendTurn(boss: PgBoss, turnId: string) {
  await boss.send(
    DURABLE_THREAD_TURN_QUEUE,
    { turnId },
    {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      singletonKey: turnId,
    }
  );
}

export async function enqueueDurableThreadTurn(turnId: string) {
  await sendTurn(await getTurnBoss(), turnId);
}

async function recoverDispatchableTurns(boss: PgBoss) {
  const turns = await knowledgeDb
    .select({ turnId: schema.threadTurnQueueState.activeTurnId })
    .from(schema.threadTurnQueueState)
    .innerJoin(
      schema.threadTurns,
      eq(schema.threadTurns.id, schema.threadTurnQueueState.activeTurnId)
    )
    .where(
      and(
        eq(schema.threadTurnQueueState.state, "running"),
        isNotNull(schema.threadTurnQueueState.activeTurnId),
        eq(schema.threadTurns.status, "queued")
      )
    );
  for (const turn of turns) {
    if (turn.turnId) {
      await sendTurn(boss, turn.turnId);
    }
  }
}

export async function startDurableThreadTurnWorker() {
  const boss = await getTurnBoss();
  if (!workerRegistered) {
    workerRegistered = true;
    await boss.work(
      DURABLE_THREAD_TURN_QUEUE,
      { batchSize: 1, includeMetadata: true },
      async (jobs: Array<{ data?: unknown }>) => {
        const { processDurableThreadTurn } = await import(
          "@/lib/turns/process-runtime"
        );
        for (const job of jobs) {
          const turnId = (job.data as { turnId?: unknown } | null)?.turnId;
          if (typeof turnId !== "string") {
            continue;
          }
          const result = await processDurableThreadTurn(turnId);
          if (result.nextTurnId) {
            await sendTurn(boss, result.nextTurnId);
          }
          await drainMobilePushOutbox().catch(reportPushFailure);
        }
      }
    );
    await recoverDispatchableTurns(boss);
    await drainMobilePushOutbox().catch(reportPushFailure);
    pushTimer = setInterval(() => {
      void drainMobilePushOutbox().catch(reportPushFailure);
    }, 5000);
  }
  return boss;
}

export async function stopDurableThreadTurnWorker() {
  if (!bossPromise) {
    return;
  }
  const boss = await bossPromise;
  if (pushTimer) {
    clearInterval(pushTimer);
    pushTimer = null;
  }
  await boss.stop({ graceful: true, timeout: 30_000 });
  bossPromise = null;
  workerRegistered = false;
}
