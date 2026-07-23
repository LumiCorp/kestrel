import { eq } from "drizzle-orm";
import { type JobWithMetadata, PgBoss } from "pg-boss";
import { ENVIRONMENT_RECONCILE_CRON } from "@/lib/environments/reconcile-schedule";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { KNOWLEDGE_DOCUMENT_QUEUE } from "@/lib/knowledge/documents/constants";
import { knowledgeQueueState } from "@/lib/knowledge/queue-state";

const ENVIRONMENT_OPERATION_QUEUE = "environment.operation";
const ENVIRONMENT_RECONCILE_QUEUE = "environment.reconcile";
const COST_PRICING_QUEUE = "costs.price";
const COST_ACCRUAL_QUEUE = "costs.accrue-fixed";
const COST_FLY_METERING_QUEUE = "costs.meter-fly";
type CostPricingJobData = { backfill?: unknown };
export const ENVIRONMENT_OPERATION_EXPIRE_SECONDS = 12 * 60 * 60;
export const ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS = 60;
export const ENVIRONMENT_OPERATION_HEARTBEAT_REFRESH_SECONDS = 30;
const MANAGED_RUNPOD_RUN_QUEUE = "ai.runpod.run";
const MANAGED_RUNPOD_RECONCILE_QUEUE = "ai.runpod.reconcile";
const MANAGED_RUNPOD_USAGE_QUEUE = "ai.runpod.usage";
const MANAGED_RUNPOD_RUN_OPTIONS = {
  retryLimit: 20,
  retryDelay: 15,
  retryBackoff: true,
} as const;
const NONTERMINAL_JOB_STATES = new Set(["active", "created", "retry"]);
let environmentMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
let environmentMaintenanceRunning = false;

async function sendManagedRunPodRun(boss: PgBoss, runId: string) {
  await boss.send(
    MANAGED_RUNPOD_RUN_QUEUE,
    { runId },
    { ...MANAGED_RUNPOD_RUN_OPTIONS, singletonKey: runId }
  );
}

async function recoverQueuedManagedRunPodRuns(boss: PgBoss) {
  const queuedRuns = await knowledgeDb.query.aiDeploymentRuns.findMany({
    where: eq(schema.aiDeploymentRuns.status, "queued"),
    columns: { id: true },
  });
  for (const run of queuedRuns) {
    await sendManagedRunPodRun(boss, run.id);
  }
}

async function createBoss() {
  if (!knowledgeQueueState.databaseUrl) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }

  const boss = new PgBoss({
    connectionString: knowledgeQueueState.databaseUrl,
    migrate: true,
  });

  await boss.start();
  await boss.createQueue(KNOWLEDGE_DOCUMENT_QUEUE);
  await boss.createQueue(ENVIRONMENT_OPERATION_QUEUE, {
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.updateQueue(ENVIRONMENT_OPERATION_QUEUE, {
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.createQueue(ENVIRONMENT_RECONCILE_QUEUE);
  await boss.schedule(
    ENVIRONMENT_RECONCILE_QUEUE,
    ENVIRONMENT_RECONCILE_CRON,
    {}
  );
  await boss.createQueue(COST_PRICING_QUEUE);
  await boss.createQueue(COST_ACCRUAL_QUEUE);
  await boss.createQueue(COST_FLY_METERING_QUEUE);
  await boss.createQueue(MANAGED_RUNPOD_RUN_QUEUE);
  await boss.createQueue(MANAGED_RUNPOD_RECONCILE_QUEUE);
  await boss.createQueue(MANAGED_RUNPOD_USAGE_QUEUE);
  return boss;
}

export async function getKnowledgeBoss() {
  if (!knowledgeQueueState.bossPromise) {
    knowledgeQueueState.bossPromise = createBoss();
  }

  const boss = await knowledgeQueueState.bossPromise;
  if (!knowledgeQueueState.workersRegistered) {
    knowledgeQueueState.workersRegistered = true;
    await boss.work(
      KNOWLEDGE_DOCUMENT_QUEUE,
      async (jobs: Array<{ data?: unknown }>) => {
        const { processKnowledgeDocumentRun } = await import(
          "@/lib/knowledge/documents/process-runtime"
        );
        for (const job of jobs) {
          const payload = job.data as { runId?: string } | null;
          if (payload?.runId) {
            await processKnowledgeDocumentRun(payload.runId);
          }
        }
      }
    );
  }

  return boss;
}

async function getKnowledgeBossProducer() {
  if (!knowledgeQueueState.bossPromise) {
    knowledgeQueueState.bossPromise = createBoss();
  }
  return knowledgeQueueState.bossPromise;
}

export async function startManagedRunPodWorker() {
  const boss = await getKnowledgeBossProducer();
  if (knowledgeQueueState.managedRunPodWorkersRegistered) return boss;
  knowledgeQueueState.managedRunPodWorkersRegistered = true;
  await boss.work(
    MANAGED_RUNPOD_RUN_QUEUE,
    async (jobs: Array<{ data?: unknown }>) => {
      const { processManagedRunPodRun } = await import(
        "@/lib/ai/managed-runpod-runtime"
      );
      for (const job of jobs) {
        const payload = job.data as { runId?: string } | null;
        if (payload?.runId) await processManagedRunPodRun(payload.runId);
      }
    }
  );
  await boss.work(MANAGED_RUNPOD_RECONCILE_QUEUE, async () => {
    await recoverQueuedManagedRunPodRuns(boss);
    const { reconcileManagedRunPodFleet } = await import(
      "@/lib/ai/managed-runpod-runtime"
    );
    await reconcileManagedRunPodFleet();
  });
  await boss.work(MANAGED_RUNPOD_USAGE_QUEUE, async () => {
    const { ingestManagedRunPodUsage } = await import(
      "@/lib/ai/managed-runpod-runtime"
    );
    await ingestManagedRunPodUsage();
  });
  const { isManagedRunPodEnabled } = await import(
    "@/lib/ai/managed-runpod-config"
  );
  if (isManagedRunPodEnabled()) {
    await boss.schedule(MANAGED_RUNPOD_RECONCILE_QUEUE, "*/5 * * * *", {});
    await boss.schedule(MANAGED_RUNPOD_USAGE_QUEUE, "15 * * * *", {});
  }
  await recoverQueuedManagedRunPodRuns(boss);
  return boss;
}

export async function enqueueKnowledgeDocumentRun(runId: string) {
  const boss = await getKnowledgeBoss();
  await boss.send(KNOWLEDGE_DOCUMENT_QUEUE, { runId });
}

export async function enqueueEnvironmentOperation(operationId: string) {
  const boss = await getKnowledgeBossProducer();
  const jobId = await boss.send(
    ENVIRONMENT_OPERATION_QUEUE,
    { operationId },
    {
      retryLimit: 20,
      retryDelay: 3,
      retryBackoff: true,
      expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
      heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
    }
  );
  if (!jobId) throw new Error("The Environment operation queue rejected the job.");
}

async function hasNonterminalEnvironmentJob(
  boss: PgBoss,
  operationId: string,
) {
  const jobs = await boss.findJobs<{ operationId?: unknown }>(
    ENVIRONMENT_OPERATION_QUEUE,
    { data: { operationId } },
  );
  return jobs.some((job) => NONTERMINAL_JOB_STATES.has(job.state));
}

export async function reconcileEnvironmentOperationQueue(boss: PgBoss) {
  const {
    isParentOwnedWorkspaceBackup,
    reconcileTerminalWorkspaceBackupRecords,
  } = await import(
    "@/lib/environments/backups"
  );
  await reconcileTerminalWorkspaceBackupRecords();
  const { PROVISIONER_OPERATION_TYPES } = await import(
    "@/lib/environments/operation-routing"
  );
  const operations = await knowledgeDb.query.environmentOperations.findMany({
    where: (table, { and, inArray }) =>
      and(
        inArray(table.status, ["queued", "running"]),
        inArray(table.type, [...PROVISIONER_OPERATION_TYPES, "workspace.backup"]),
      ),
    columns: { id: true, status: true, type: true, input: true },
    limit: 100,
  });
  for (const operation of operations) {
    if (await hasNonterminalEnvironmentJob(boss, operation.id)) continue;
    if (operation.status === "running" && operation.type === "workspace.backup") {
      if (isParentOwnedWorkspaceBackup(operation.input)) continue;
      const { failInterruptedWorkspaceBackup } = await import(
        "@/lib/environments/backups"
      );
      await failInterruptedWorkspaceBackup(operation.id);
      continue;
    }
    await enqueueEnvironmentOperation(operation.id);
  }
}

async function runEnvironmentMaintenance(boss: PgBoss) {
  if (environmentMaintenanceRunning) return;
  environmentMaintenanceRunning = true;
  try {
    await reconcileEnvironmentOperationQueue(boss);
  } finally {
    environmentMaintenanceRunning = false;
  }
}

export async function startEnvironmentLifecycleWorker() {
  const boss = await getKnowledgeBossProducer();
  if (knowledgeQueueState.environmentWorkersRegistered) return boss;
  knowledgeQueueState.environmentWorkersRegistered = true;
  await boss.work(
    ENVIRONMENT_OPERATION_QUEUE,
    {
      batchSize: 1,
      includeMetadata: true,
      heartbeatRefreshSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_REFRESH_SECONDS,
    },
    async (jobs: Array<JobWithMetadata<{ operationId?: unknown }>>) => {
      const { processEnvironmentOperation } = await import(
        "@/lib/environments/process-runtime"
      );
      for (const job of jobs) {
        if (typeof job.data?.operationId !== "string") continue;
        await processEnvironmentOperation(job.data.operationId, {
          workerSignal: job.signal,
        });
      }
    },
  );
  await boss.work(ENVIRONMENT_RECONCILE_QUEUE, async () => {
    const { runScheduledEnvironmentReconciliation } = await import(
      "@/lib/environments/reconcile-schedule"
    );
    await runScheduledEnvironmentReconciliation();
  });
  await boss.work(
    COST_PRICING_QUEUE,
    async (jobs: Array<{ data?: CostPricingJobData }>) => {
      const { backfillAuthoritativeUsage } = await import(
        "@/lib/costs/metering"
      );
      const { priceRecentUnpricedUsage, priceRecentlyUpdatedUsage } =
        await import("@/lib/costs/store");
      for (const job of jobs) {
        const backfill = job.data?.backfill;
        if (backfill !== "startup" && backfill !== "incremental") continue;
        const windowMs =
          backfill === "startup"
            ? 48 * 60 * 60 * 1000
            : 15 * 60 * 1000;
        await backfillAuthoritativeUsage({
          since: new Date(Date.now() - windowMs),
        });
      }
      await priceRecentlyUpdatedUsage(
        new Date(Date.now() - 15 * 60 * 1000)
      );
      await priceRecentUnpricedUsage();
    }
  );
  await boss.work(COST_ACCRUAL_QUEUE, async () => {
    const { accrueOrganizationFixedRates } = await import("@/lib/costs/metering");
    await accrueOrganizationFixedRates();
  });
  await boss.work(COST_FLY_METERING_QUEUE, async () => {
    const { meterFlyReconciledHour } = await import("@/lib/costs/metering");
    await meterFlyReconciledHour();
  });
  await boss.schedule(COST_PRICING_QUEUE, "*/5 * * * *", {
    backfill: "incremental",
  });
  await boss.schedule(COST_FLY_METERING_QUEUE, "5 * * * *", {});
  await boss.schedule(COST_ACCRUAL_QUEUE, "10 0 * * *", {});
  await boss.send(
    COST_PRICING_QUEUE,
    { backfill: "startup" },
    { singletonKey: "startup-backfill" }
  );
  await boss.send(COST_ACCRUAL_QUEUE, {}, { singletonKey: "startup-accrual" });
  await reconcileEnvironmentOperationQueue(boss);
  environmentMaintenanceTimer = setInterval(() => {
    void runEnvironmentMaintenance(boss).catch((error) => {
      console.error("Environment lifecycle worker maintenance failed.", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    });
  }, 5000);
  return boss;
}

export async function stopEnvironmentLifecycleWorker() {
  if (environmentMaintenanceTimer) {
    clearInterval(environmentMaintenanceTimer);
    environmentMaintenanceTimer = null;
  }
  if (!knowledgeQueueState.bossPromise) return;
  const boss = await knowledgeQueueState.bossPromise;
  await boss.stop({ graceful: true, timeout: 30_000 });
  knowledgeQueueState.bossPromise = null;
  knowledgeQueueState.environmentWorkersRegistered = false;
}

export async function enqueueManagedRunPodRun(runId: string) {
  const boss = await getKnowledgeBossProducer();
  await sendManagedRunPodRun(boss, runId);
}

export async function enqueueManagedRunPodReconciliation() {
  const boss = await getKnowledgeBossProducer();
  await boss.send(MANAGED_RUNPOD_RECONCILE_QUEUE, {});
}

export async function enqueueManagedRunPodUsageIngestion() {
  const boss = await getKnowledgeBossProducer();
  await boss.send(MANAGED_RUNPOD_USAGE_QUEUE, {});
}

export {
  ENVIRONMENT_OPERATION_QUEUE,
  ENVIRONMENT_RECONCILE_QUEUE,
  MANAGED_RUNPOD_RECONCILE_QUEUE,
  MANAGED_RUNPOD_RUN_QUEUE,
  MANAGED_RUNPOD_USAGE_QUEUE,
};
