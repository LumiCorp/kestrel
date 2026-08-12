import "server-only";

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type JobWithMetadata, PgBoss } from "pg-boss";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { completeDurableThreadTurn } from "@/lib/turns/store";

export const DURABLE_THREAD_TURN_QUEUE = "thread.turn.execute";
export const DURABLE_TURN_EXPIRE_SECONDS = 12 * 60 * 60;
export const DURABLE_TURN_HEARTBEAT_SECONDS = 60;
export const DURABLE_TURN_HEARTBEAT_REFRESH_SECONDS = 30;

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

async function drainRuntimeBindingReleaseOutbox() {
  const {
    deliverRuntimeBindingRelease,
    processRuntimeBindingReleaseOutbox,
  } = await import("@/lib/runtimes/release-outbox");
  await processRuntimeBindingReleaseOutbox(deliverRuntimeBindingRelease);
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
  await boss.createQueue(DURABLE_THREAD_TURN_QUEUE, {
    expireInSeconds: DURABLE_TURN_EXPIRE_SECONDS,
    heartbeatSeconds: DURABLE_TURN_HEARTBEAT_SECONDS,
  });
  await boss.updateQueue(DURABLE_THREAD_TURN_QUEUE, {
    expireInSeconds: DURABLE_TURN_EXPIRE_SECONDS,
    heartbeatSeconds: DURABLE_TURN_HEARTBEAT_SECONDS,
  });
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
      expireInSeconds: DURABLE_TURN_EXPIRE_SECONDS,
      heartbeatSeconds: DURABLE_TURN_HEARTBEAT_SECONDS,
    },
  );
  if (!jobId) {
    throw new Error("The durable turn queue rejected the job.");
  }
}

async function dispatchTurnOrReconcile(boss: PgBoss, turnId: string) {
  try {
    await sendTurn(boss, turnId);
  } catch (error) {
    try {
      if (await hasNonterminalJob(boss, turnId)) {
        return;
      }
      const state = await readDurableDispatchState(turnId);
      if (
        state &&
        (state.queueState !== "running" ||
          state.activeTurnId !== turnId ||
          (state.status !== "queued" &&
            state.status !== "waiting_for_input"))
      ) {
        return;
      }
    } catch {
      // Preserve the durable dispatch intent when the send result cannot be
      // reconciled. Existing maintenance will retry once state is readable.
    }
    throw error;
  }
}

export async function enqueueDurableThreadTurn(turnId: string) {
  await dispatchTurnOrReconcile(await getTurnBoss(), turnId);
}

export async function finalizeExhaustedDurableTurnJob(input: {
  turnId: string;
  retryCount: number;
  retryLimit: number;
}) {
  if (input.retryCount < input.retryLimit) {
    return false;
  }
  const dispatchState = await readDurableDispatchState(input.turnId);
  if (dispatchState?.runtimeEventReconciliationState === "pending") {
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
    { data: { turnId } },
  );
  return jobs.some((job) => NONTERMINAL_JOB_STATES.has(job.state));
}

async function readDurableDispatchState(turnId: string) {
  const [state] = await knowledgeDb
    .select({
      activeTurnId: schema.threadTurnQueueState.activeTurnId,
      queueState: schema.threadTurnQueueState.state,
      status: schema.threadTurns.status,
      runtimeEventReconciliationState:
        schema.environmentRunExecutions.runtimeEventReconciliationState,
    })
    .from(schema.threadTurns)
    .innerJoin(
      schema.threadTurnQueueState,
      eq(schema.threadTurnQueueState.threadId, schema.threadTurns.threadId),
    )
    .leftJoin(
      schema.environmentRunExecutions,
      eq(schema.environmentRunExecutions.id, schema.threadTurns.environmentExecutionId),
    )
    .where(eq(schema.threadTurns.id, turnId))
    .limit(1);
  return state;
}

async function hasAnsweredUndeliveredRuntimeInteraction(turnId: string) {
  const interaction = await knowledgeDb.query.threadInteractions.findFirst({
    columns: { id: true },
    where: and(
      eq(schema.threadInteractions.turnId, turnId),
      eq(schema.threadInteractions.source, "runtime"),
      eq(schema.threadInteractions.status, "processing"),
      isNull(schema.threadInteractions.resumedAt),
    ),
  });
  return Boolean(interaction);
}

async function reconcileDurableThreadTurnQueueWithBoss(boss: PgBoss) {
  const turns = await knowledgeDb
    .select({
      queueState: schema.threadTurnQueueState.state,
      status: schema.threadTurns.status,
      turnId: schema.threadTurnQueueState.activeTurnId,
      runtimeEventReconciliationState:
        schema.environmentRunExecutions.runtimeEventReconciliationState,
    })
    .from(schema.threadTurnQueueState)
    .innerJoin(
      schema.threadTurns,
      eq(schema.threadTurns.id, schema.threadTurnQueueState.activeTurnId),
    )
    .leftJoin(
      schema.environmentRunExecutions,
      eq(schema.environmentRunExecutions.id, schema.threadTurns.environmentExecutionId),
    )
    .where(
      and(
        isNotNull(schema.threadTurnQueueState.activeTurnId),
        inArray(schema.threadTurns.status, [
          "queued",
          "running",
          "waiting_for_input",
        ]),
      ),
    );
  for (const turn of turns) {
    if (!(turn.turnId && !(await hasNonterminalJob(boss, turn.turnId)))) {
      continue;
    }
    if (turn.status === "queued" && turn.queueState === "running") {
      await dispatchTurnOrReconcile(boss, turn.turnId);
      continue;
    }
    // A waiting turn is intentionally quiescent: its next worker job is only
    // created after the exact durable interaction request is resolved.
    if (turn.status === "waiting_for_input") {
      if (
        turn.queueState === "running" &&
        (await hasAnsweredUndeliveredRuntimeInteraction(turn.turnId))
      ) {
        await dispatchTurnOrReconcile(boss, turn.turnId);
      }
      continue;
    }
    if (turn.status === "running") {
      if (turn.runtimeEventReconciliationState === "pending") {
        await dispatchTurnOrReconcile(boss, turn.turnId);
        continue;
      }
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
    await drainRuntimeBindingReleaseOutbox().catch(reportRuntimeReleaseFailure);
  } finally {
    maintenanceRunning = false;
  }
}

function reportRuntimeReleaseFailure(error: unknown) {
  console.error("Kestrel One Runtime release reconciliation failed.", {
    code:
      error && typeof error === "object" && "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "RUNTIME_RELEASE_RECONCILIATION_FAILED",
  });
}

export async function startDurableThreadTurnWorker() {
  const boss = await getTurnBoss();
  if (!workerRegistered) {
    workerRegistered = true;
    await boss.work(
      DURABLE_THREAD_TURN_QUEUE,
      {
        batchSize: 1,
        includeMetadata: true,
        heartbeatRefreshSeconds: DURABLE_TURN_HEARTBEAT_REFRESH_SECONDS,
      },
      async (jobs: Array<JobWithMetadata<{ turnId?: unknown }>>) => {
        for (const job of jobs) {
          const turnId = job.data?.turnId;
          if (typeof turnId !== "string") {
            continue;
          }
          try {
            const { processDurableThreadTurn } =
              await import("@/lib/turns/process-runtime");
            const result = await processDurableThreadTurn(turnId, {
              retryCount: job.retryCount,
              workerSignal: job.signal,
            });
            if (result.nextTurnId) {
              await dispatchTurnOrReconcile(boss, result.nextTurnId);
            }
            await drainMobilePushOutbox().catch(reportPushFailure);
            await drainRuntimeBindingReleaseOutbox().catch(reportRuntimeReleaseFailure);
          } catch (error) {
            await finalizeExhaustedDurableTurnJob({
              turnId,
              retryCount: job.retryCount,
              retryLimit: job.retryLimit,
            });
            throw error;
          }
        }
      },
    );
    await reconcileDurableThreadTurnQueueWithBoss(boss);
    await drainMobilePushOutbox().catch(reportPushFailure);
    await drainRuntimeBindingReleaseOutbox().catch(reportRuntimeReleaseFailure);
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
