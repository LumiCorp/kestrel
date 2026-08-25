import "server-only";

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type JobWithMetadata, PgBoss } from "pg-boss";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { resolveTurnWorkerConcurrency } from "@/lib/runtime/process-contracts";
import {
  claimDueProjectPromptScheduleRuns,
  failProjectPromptScheduleRun,
  listQueuedProjectPromptScheduleRunIds,
} from "@/lib/schedules/store";
import { createSingleFlightOperation } from "@/lib/turns/single-flight";
import { completeDurableThreadTurn } from "@/lib/turns/store";
import { resolveTurnConcurrencyGroup } from "@/lib/turns/concurrency";

export const DURABLE_THREAD_TURN_QUEUE = "thread.turn.execute";
export const PROJECT_PROMPT_SCHEDULE_DISPATCH_QUEUE =
  "project.prompt-schedule.dispatch";
export const PROJECT_PROMPT_SCHEDULE_EXECUTION_QUEUE =
  "project.prompt-schedule.execute";
export const PROJECT_PROMPT_SCHEDULE_DISPATCH_CRON = "* * * * *";
export const DURABLE_TURN_EXPIRE_SECONDS = 12 * 60 * 60;
export const DURABLE_TURN_HEARTBEAT_SECONDS = 60;
export const DURABLE_TURN_HEARTBEAT_REFRESH_SECONDS = 30;
export const PROJECT_PROMPT_SCHEDULE_LOCAL_CONCURRENCY = 2;

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
let bossPromise: Promise<PgBoss> | null = null;
let workerRegistered = false;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

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
  await boss.createQueue(DURABLE_THREAD_TURN_QUEUE, {
    expireInSeconds: DURABLE_TURN_EXPIRE_SECONDS,
    heartbeatSeconds: DURABLE_TURN_HEARTBEAT_SECONDS,
  });
  await boss.updateQueue(DURABLE_THREAD_TURN_QUEUE, {
    expireInSeconds: DURABLE_TURN_EXPIRE_SECONDS,
    heartbeatSeconds: DURABLE_TURN_HEARTBEAT_SECONDS,
  });
  await boss.createQueue(PROJECT_PROMPT_SCHEDULE_DISPATCH_QUEUE);
  await boss.createQueue(PROJECT_PROMPT_SCHEDULE_EXECUTION_QUEUE);
  await boss.schedule(
    PROJECT_PROMPT_SCHEDULE_DISPATCH_QUEUE,
    PROJECT_PROMPT_SCHEDULE_DISPATCH_CRON,
    {},
  );
  return boss;
}

async function getTurnBoss() {
  bossPromise ??= createTurnBoss();
  return bossPromise;
}

async function sendTurn(boss: PgBoss, turnId: string) {
  const [turn] = await knowledgeDb
    .select({
      concurrencyGroupKey: schema.threadTurns.concurrencyGroupKey,
      id: schema.threads.id,
      organizationId: schema.threads.organizationId,
      projectId: schema.threads.projectId,
      createdByUserId: schema.threads.createdByUserId,
      workspaceMode: schema.threads.workspaceMode,
    })
    .from(schema.threadTurns)
    .innerJoin(schema.threads, eq(schema.threads.id, schema.threadTurns.threadId))
    .where(eq(schema.threadTurns.id, turnId))
    .limit(1);
  if (!turn) throw new Error("The durable turn is unavailable for dispatch.");
  const concurrencyGroupKey =
    turn.concurrencyGroupKey ?? resolveTurnConcurrencyGroup(turn);
  const jobId = await boss.send(
    DURABLE_THREAD_TURN_QUEUE,
    { turnId },
    {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: DURABLE_TURN_EXPIRE_SECONDS,
      heartbeatSeconds: DURABLE_TURN_HEARTBEAT_SECONDS,
      group: { id: concurrencyGroupKey },
    },
  );
  if (!jobId) {
    throw new Error("The durable turn queue rejected the job.");
  }
}

async function sendProjectPromptScheduleRun(boss: PgBoss, runId: string) {
  const jobId = await boss.send(
    PROJECT_PROMPT_SCHEDULE_EXECUTION_QUEUE,
    { runId },
    { retryLimit: 3, retryDelay: 5, retryBackoff: true },
  );
  if (!jobId) {
    throw new Error("The scheduled prompt queue rejected the occurrence.");
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
  await completeDurableThreadTurn({
    turnId: input.turnId,
    status: "failed",
    failureCode: "TURN_DISPATCH_FAILED",
    failureMessage:
      "The Kestrel agent could not start this turn. Please try again.",
    interactionFailure: {
      failureCode: "TURN_DISPATCH_FAILED",
      failureMessage: "The durable queue exhausted dispatch before the runner started.",
      effectStatus: "not_started",
      retryable: true,
    },
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

async function hasNonterminalProjectPromptScheduleJob(
  boss: PgBoss,
  runId: string,
) {
  const jobs = await boss.findJobs<{ runId?: unknown }>(
    PROJECT_PROMPT_SCHEDULE_EXECUTION_QUEUE,
    { data: { runId } },
  );
  return jobs.some((job) => NONTERMINAL_JOB_STATES.has(job.state));
}

async function dispatchDueProjectPromptSchedules(boss: PgBoss) {
  const runIds = await claimDueProjectPromptScheduleRuns();
  for (const runId of runIds) {
    await sendProjectPromptScheduleRun(boss, runId);
  }
}

async function recoverQueuedProjectPromptScheduleRuns(boss: PgBoss) {
  const runIds = await listQueuedProjectPromptScheduleRunIds();
  for (const runId of runIds) {
    if (!(await hasNonterminalProjectPromptScheduleJob(boss, runId))) {
      await sendProjectPromptScheduleRun(boss, runId);
    }
  }
}

async function readDurableDispatchState(turnId: string) {
  const [state] = await knowledgeDb
    .select({
      activeTurnId: schema.threadTurnQueueState.activeTurnId,
      queueState: schema.threadTurnQueueState.state,
      status: schema.threadTurns.status,
    })
    .from(schema.threadTurns)
    .innerJoin(
      schema.threadTurnQueueState,
      eq(schema.threadTurnQueueState.threadId, schema.threadTurns.threadId),
    )
    .where(eq(schema.threadTurns.id, turnId))
    .limit(1);
  return state;
}

async function hasResolvedUnconsumedRuntimeInteraction(turnId: string) {
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
  const capacity =
    await knowledgeDb.query.platformTurnWorkerCapacity.findFirst({
      where: eq(schema.platformTurnWorkerCapacity.id, "default"),
      columns: { admissionClosedUntil: true },
    });
  if (!capacity) {
    throw new Error("Turn Worker capacity configuration is unavailable.");
  }
  if (
    capacity.admissionClosedUntil &&
    capacity.admissionClosedUntil.getTime() > Date.now()
  ) {
    return;
  }
  const turns = await knowledgeDb
    .select({
      queueState: schema.threadTurnQueueState.state,
      status: schema.threadTurns.status,
      turnId: schema.threadTurnQueueState.activeTurnId,
    })
    .from(schema.threadTurnQueueState)
    .innerJoin(
      schema.threadTurns,
      eq(schema.threadTurns.id, schema.threadTurnQueueState.activeTurnId),
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
        (await hasResolvedUnconsumedRuntimeInteraction(turn.turnId))
      ) {
        await dispatchTurnOrReconcile(boss, turn.turnId);
      }
      continue;
    }
    if (turn.status === "running") {
      await completeDurableThreadTurn({
        turnId: turn.turnId,
        status: "failed",
        failureCode: "TURN_WORKER_INTERRUPTED",
        failureMessage:
          "The Kestrel agent was interrupted before this turn finished. Please try again.",
        interactionFailure: {
          failureCode: "TURN_WORKER_INTERRUPTED",
          failureMessage: "The orphaned worker could not prove whether execution started.",
          effectStatus: "unknown",
          retryable: false,
        },
      });
    }
  }
}

export async function reconcileDurableThreadTurnQueue() {
  await reconcileDurableThreadTurnQueueWithBoss(await getTurnBoss());
}

function createWorkerMaintenance(boss: PgBoss) {
  return createSingleFlightOperation(async () => {
    await recoverQueuedProjectPromptScheduleRuns(boss);
    await reconcileDurableThreadTurnQueueWithBoss(boss);
    await drainMobilePushOutbox().catch(reportPushFailure);
  });
}

export async function startDurableThreadTurnWorker() {
  const turnWorkerConcurrency = resolveTurnWorkerConcurrency();
  const boss = await getTurnBoss();
  if (!workerRegistered) {
    workerRegistered = true;
    const runWorkerMaintenance = createWorkerMaintenance(boss);
    await boss.work(PROJECT_PROMPT_SCHEDULE_DISPATCH_QUEUE, async () => {
      await dispatchDueProjectPromptSchedules(boss);
    });
    await boss.work(
      PROJECT_PROMPT_SCHEDULE_EXECUTION_QUEUE,
      {
        batchSize: 1,
        localConcurrency: PROJECT_PROMPT_SCHEDULE_LOCAL_CONCURRENCY,
        includeMetadata: true,
      },
      async (jobs: Array<JobWithMetadata<{ runId?: unknown }>>) => {
        for (const job of jobs) {
          const runId = job.data?.runId;
          if (typeof runId !== "string") continue;
          try {
            const { materializeProjectPromptScheduleRun } =
              await import("@/lib/schedules/runtime");
            const turnId = await materializeProjectPromptScheduleRun(runId);
            if (turnId) await dispatchTurnOrReconcile(boss, turnId);
          } catch (error) {
            if (job.retryCount >= job.retryLimit) {
              await failProjectPromptScheduleRun({
                runId,
                code:
                  error &&
                  typeof error === "object" &&
                  "code" in error &&
                  typeof error.code === "string"
                    ? error.code
                    : "SCHEDULE_EXECUTION_FAILED",
                message:
                  error instanceof Error
                    ? error.message
                    : "The scheduled prompt could not start.",
              });
            }
            throw error;
          }
        }
      },
    );
    await boss.work(
      DURABLE_THREAD_TURN_QUEUE,
      {
        batchSize: 1,
        localConcurrency: turnWorkerConcurrency,
        groupConcurrency: 1,
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
            await runWorkerMaintenance();
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
    await runWorkerMaintenance();
    maintenanceTimer = setInterval(() => {
      void runWorkerMaintenance().catch((error) => {
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
