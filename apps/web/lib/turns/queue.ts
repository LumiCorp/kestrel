import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { type JobWithMetadata, PgBoss } from "pg-boss";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { completeDurableThreadTurn } from "@/lib/turns/store";

export const DURABLE_THREAD_TURN_QUEUE = "thread.turn.execute";

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
let bossPromise: Promise<PgBoss> | null = null;
let workerRegistered = false;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let maintenanceRunning = false;

const NONTERMINAL_JOB_STATES = new Set(["active", "created", "retry"]);

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
  const jobId = await boss.send(
    DURABLE_THREAD_TURN_QUEUE,
    { turnId },
    {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
    }
  );
  if (!jobId) {
    throw new Error("The durable turn queue rejected the job.");
  }
}

async function dispatchTurnOrFail(boss: PgBoss, turnId: string) {
  try {
    await sendTurn(boss, turnId);
  } catch (error) {
    await completeDurableThreadTurn({
      turnId,
      status: "failed",
      failureCode: "TURN_DISPATCH_FAILED",
      failureMessage:
        "The Kestrel agent could not start this turn. Please try again.",
    });
    throw error;
  }
}

export async function enqueueDurableThreadTurn(turnId: string) {
  await dispatchTurnOrFail(await getTurnBoss(), turnId);
}

export async function finalizeExhaustedDurableTurnJob(input: {
  turnId: string;
  retryCount: number;
  retryLimit: number;
}) {
  if (input.retryCount < input.retryLimit) {
    return false;
  }
  await completeDurableThreadTurn({
    turnId: input.turnId,
    status: "failed",
    failureCode: "TURN_DISPATCH_FAILED",
    failureMessage:
      "The Kestrel agent could not start this turn. Please try again.",
  });
  return true;
}

async function hasNonterminalJob(boss: PgBoss, turnId: string) {
  const jobs = await boss.findJobs<{ turnId?: unknown }>(
    DURABLE_THREAD_TURN_QUEUE,
    { data: { turnId } }
  );
  return jobs.some((job) => NONTERMINAL_JOB_STATES.has(job.state));
}

async function reconcileDurableThreadTurnQueueWithBoss(boss: PgBoss) {
  const turns = await knowledgeDb
    .select({
      queueState: schema.threadTurnQueueState.state,
      status: schema.threadTurns.status,
      turnId: schema.threadTurnQueueState.activeTurnId,
    })
    .from(schema.threadTurnQueueState)
    .innerJoin(
      schema.threadTurns,
      eq(schema.threadTurns.id, schema.threadTurnQueueState.activeTurnId)
    )
    .where(
      and(
        isNotNull(schema.threadTurnQueueState.activeTurnId),
        inArray(schema.threadTurns.status, [
          "queued",
          "running",
          "waiting_for_input",
        ])
      )
    );
  for (const turn of turns) {
    if (!(turn.turnId && !(await hasNonterminalJob(boss, turn.turnId)))) {
      continue;
    }
    if (turn.status === "queued" && turn.queueState === "running") {
      await dispatchTurnOrFail(boss, turn.turnId);
      continue;
    }
    if (turn.status === "running" || turn.status === "waiting_for_input") {
      await completeDurableThreadTurn({
        turnId: turn.turnId,
        status: "failed",
        failureCode: "TURN_WORKER_INTERRUPTED",
        failureMessage:
          "The Kestrel agent was interrupted before this turn finished. Please try again.",
      });
    }
  }
}

export async function reconcileDurableThreadTurnQueue() {
  await reconcileDurableThreadTurnQueueWithBoss(await getTurnBoss());
}

async function runWorkerMaintenance(boss: PgBoss) {
  if (maintenanceRunning) {
    return;
  }
  maintenanceRunning = true;
  try {
    await reconcileDurableThreadTurnQueueWithBoss(boss);
    await drainMobilePushOutbox().catch(reportPushFailure);
  } finally {
    maintenanceRunning = false;
  }
}

export async function startDurableThreadTurnWorker() {
  const boss = await getTurnBoss();
  if (!workerRegistered) {
    workerRegistered = true;
    await boss.work(
      DURABLE_THREAD_TURN_QUEUE,
      { batchSize: 1, includeMetadata: true },
      async (jobs: Array<JobWithMetadata<{ turnId?: unknown }>>) => {
        for (const job of jobs) {
          const turnId = job.data?.turnId;
          if (typeof turnId !== "string") {
            continue;
          }
          try {
            const { processDurableThreadTurn } = await import(
              "@/lib/turns/process-runtime"
            );
            const result = await processDurableThreadTurn(turnId);
            if (result.nextTurnId) {
              await dispatchTurnOrFail(boss, result.nextTurnId);
            }
            await drainMobilePushOutbox().catch(reportPushFailure);
          } catch (error) {
            await finalizeExhaustedDurableTurnJob({
              turnId,
              retryCount: job.retryCount,
              retryLimit: job.retryLimit,
            });
            throw error;
          }
        }
      }
    );
    await reconcileDurableThreadTurnQueueWithBoss(boss);
    await drainMobilePushOutbox().catch(reportPushFailure);
    maintenanceTimer = setInterval(() => {
      void runWorkerMaintenance(boss).catch((error) => {
        console.error("Kestrel One worker maintenance failed.", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      });
    }, 5000);
  }
  return boss;
}

export async function stopDurableThreadTurnWorker() {
  if (!bossPromise) {
    return;
  }
  const boss = await bossPromise;
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
  await boss.stop({ graceful: true, timeout: 30_000 });
  bossPromise = null;
  workerRegistered = false;
}
