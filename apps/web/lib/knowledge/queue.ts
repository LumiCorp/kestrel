import { and, eq, inArray, sql } from "drizzle-orm";
import { type JobWithMetadata, PgBoss } from "pg-boss";
import { ENVIRONMENT_RECONCILE_CRON } from "@/lib/environments/reconcile-schedule";
import {
  DAILY_BACKUP_MAX_ATTEMPTS,
  isDailyWorkspaceBackupIdempotencyKey,
} from "@/lib/environments/daily-backup-contract";
import { parseEnvironmentWorkerAttempt } from "@/lib/environments/worker-failure";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  KNOWLEDGE_DOCUMENT_QUEUE,
  LEGACY_KNOWLEDGE_DOCUMENT_QUEUE,
} from "@/lib/knowledge/documents/constants";
import { knowledgeQueueState } from "@/lib/knowledge/queue-state";

const LEGACY_ORGANIZATION_DELETION_QUEUE = "organization.deletion";
const LEGACY_ORGANIZATION_DELETION_QUEUE_V2 = "organization.deletion.v2";
// Retain the durable lifecycle queue names across cutover so existing tenant
// operations remain processable. These queues no longer carry release work.
const ENVIRONMENT_OPERATION_QUEUE = "environment.operation.controller-v1";
const ORGANIZATION_DELETION_QUEUE = "organization.deletion.controller-v1";
const ENVIRONMENT_RECONCILE_QUEUE = "environment.reconcile.controller-v1";
const COST_PRICING_QUEUE = "costs.price";
const COST_ACCRUAL_QUEUE = "costs.accrue-fixed";
const COST_FLY_METERING_QUEUE = "costs.meter-fly";
export const TURN_WORKER_CAPACITY_QUEUE = "platform.turn-worker-capacity.v1";
type CostPricingJobData = { backfill?: unknown };
export const ENVIRONMENT_OPERATION_EXPIRE_SECONDS = 12 * 60 * 60;
export const ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS = 60;
export const ENVIRONMENT_OPERATION_HEARTBEAT_REFRESH_SECONDS = 30;
export const ENVIRONMENT_OPERATION_RETRY_LIMIT = 20;
const ENVIRONMENT_OPERATION_RETRY_DELAY_SECONDS = 3;
const MANAGED_RUNPOD_RUN_QUEUE = "ai.runpod.run";
const MANAGED_RUNPOD_RECONCILE_QUEUE = "ai.runpod.reconcile";
const MANAGED_RUNPOD_USAGE_QUEUE = "ai.runpod.usage";
const MANAGED_RUNPOD_RUN_OPTIONS = {
  retryLimit: 20,
  retryDelay: 15,
  retryBackoff: true,
} as const;
const KNOWLEDGE_DOCUMENT_EXPIRE_SECONDS = 60 * 60;
const KNOWLEDGE_DOCUMENT_HEARTBEAT_SECONDS = 60;
const KNOWLEDGE_DOCUMENT_HEARTBEAT_REFRESH_SECONDS = 30;
const KNOWLEDGE_DOCUMENT_RETRY_LIMIT = 2;
const KNOWLEDGE_DOCUMENT_RECONCILE_INTERVAL_MS = 60_000;
const NONTERMINAL_JOB_STATES = new Set(["active", "created", "retry"]);
const TERMINAL_JOB_STATES = new Set(["completed", "cancelled", "failed"]);
let environmentMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
let environmentMaintenanceRunning = false;
let knowledgeMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
let knowledgeMaintenanceRunning = false;
let knowledgeWorkerDrain: Promise<void> = Promise.resolve();
let controlWorkersStopPromise: Promise<void> | null = null;

type KnowledgeDocumentJobData = {
  runId?: unknown;
  documentId?: unknown;
};

async function sendManagedRunPodRun(boss: PgBoss, runId: string) {
  await boss.send(
    MANAGED_RUNPOD_RUN_QUEUE,
    { runId },
    { ...MANAGED_RUNPOD_RUN_OPTIONS, singletonKey: runId },
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
  await boss.createQueue(LEGACY_KNOWLEDGE_DOCUMENT_QUEUE);
  await boss.createQueue(KNOWLEDGE_DOCUMENT_QUEUE, {
    policy: "singleton",
    expireInSeconds: KNOWLEDGE_DOCUMENT_EXPIRE_SECONDS,
    heartbeatSeconds: KNOWLEDGE_DOCUMENT_HEARTBEAT_SECONDS,
    retryLimit: KNOWLEDGE_DOCUMENT_RETRY_LIMIT,
  });
  await boss.updateQueue(KNOWLEDGE_DOCUMENT_QUEUE, {
    expireInSeconds: KNOWLEDGE_DOCUMENT_EXPIRE_SECONDS,
    heartbeatSeconds: KNOWLEDGE_DOCUMENT_HEARTBEAT_SECONDS,
    retryLimit: KNOWLEDGE_DOCUMENT_RETRY_LIMIT,
  });
  await boss.createQueue(ENVIRONMENT_OPERATION_QUEUE, {
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.createQueue(LEGACY_ORGANIZATION_DELETION_QUEUE, {
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.createQueue(LEGACY_ORGANIZATION_DELETION_QUEUE_V2, {
    policy: "singleton",
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.createQueue(ORGANIZATION_DELETION_QUEUE, {
    policy: "singleton",
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.updateQueue(ENVIRONMENT_OPERATION_QUEUE, {
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.updateQueue(ORGANIZATION_DELETION_QUEUE, {
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.updateQueue(LEGACY_ORGANIZATION_DELETION_QUEUE, {
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.updateQueue(LEGACY_ORGANIZATION_DELETION_QUEUE_V2, {
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.createQueue(ENVIRONMENT_RECONCILE_QUEUE);
  await boss.schedule(
    ENVIRONMENT_RECONCILE_QUEUE,
    ENVIRONMENT_RECONCILE_CRON,
    {},
  );
  await boss.createQueue(COST_PRICING_QUEUE);
  await boss.createQueue(COST_ACCRUAL_QUEUE);
  await boss.createQueue(COST_FLY_METERING_QUEUE);
  await boss.createQueue(TURN_WORKER_CAPACITY_QUEUE, {
    policy: "singleton",
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
  });
  await boss.createQueue(MANAGED_RUNPOD_RUN_QUEUE);
  await boss.createQueue(MANAGED_RUNPOD_RECONCILE_QUEUE);
  await boss.createQueue(MANAGED_RUNPOD_USAGE_QUEUE);
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
      const { processManagedRunPodRun } =
        await import("@/lib/ai/managed-runpod-runtime");
      for (const job of jobs) {
        const payload = job.data as { runId?: string } | null;
        if (payload?.runId) await processManagedRunPodRun(payload.runId);
      }
    },
  );
  await boss.work(MANAGED_RUNPOD_RECONCILE_QUEUE, async () => {
    await recoverQueuedManagedRunPodRuns(boss);
    const { reconcileManagedRunPodFleet } =
      await import("@/lib/ai/managed-runpod-runtime");
    await reconcileManagedRunPodFleet();
  });
  await boss.work(MANAGED_RUNPOD_USAGE_QUEUE, async () => {
    const { ingestManagedRunPodUsage } =
      await import("@/lib/ai/managed-runpod-runtime");
    await ingestManagedRunPodUsage();
  });
  const { isManagedRunPodEnabled } =
    await import("@/lib/ai/managed-runpod-config");
  if (isManagedRunPodEnabled()) {
    await boss.schedule(MANAGED_RUNPOD_RECONCILE_QUEUE, "*/5 * * * *", {});
    await boss.schedule(MANAGED_RUNPOD_USAGE_QUEUE, "15 * * * *", {});
  }
  await recoverQueuedManagedRunPodRuns(boss);
  return boss;
}

async function findKnowledgeDocumentJobs(boss: PgBoss, runId: string) {
  const [currentJob, legacyJobs] = await Promise.all([
    boss.getJobById<KnowledgeDocumentJobData>(KNOWLEDGE_DOCUMENT_QUEUE, runId),
    boss.findJobs<KnowledgeDocumentJobData>(LEGACY_KNOWLEDGE_DOCUMENT_QUEUE, {
      data: { runId },
    }),
  ]);
  return [
    ...(currentJob ? [{ queueName: KNOWLEDGE_DOCUMENT_QUEUE, job: currentJob }] : []),
    ...legacyJobs.map((job) => ({
      queueName: LEGACY_KNOWLEDGE_DOCUMENT_QUEUE,
      job,
    })),
  ];
}

export async function ensureKnowledgeDocumentRunQueued(input: {
  runId: string;
  documentId: string;
}) {
  const boss = await getKnowledgeBossProducer();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-document-queue:${input.runId}`}, 0))`,
    );
    const [run] = await transaction
      .select({
        documentId: schema.knowledgeIngestionRuns.documentId,
        status: schema.knowledgeIngestionRuns.status,
      })
      .from(schema.knowledgeIngestionRuns)
      .where(eq(schema.knowledgeIngestionRuns.id, input.runId))
      .limit(1)
      .for("update");
    if (!run) {
      throw new Error("Knowledge ingestion run not found.");
    }
    if (run.documentId !== input.documentId) {
      throw new Error("Knowledge ingestion run does not match its document.");
    }
    if (run.status !== "queued" && run.status !== "running") {
      return { disposition: "skipped" as const, deletedTerminalJobs: 0 };
    }
    const existingJobs = await findKnowledgeDocumentJobs(boss, input.runId);
    if (
      existingJobs.some(({ job }) => NONTERMINAL_JOB_STATES.has(job.state))
    ) {
      return { disposition: "preserved" as const, deletedTerminalJobs: 0 };
    }

    let deletedTerminalJobs = 0;
    for (const { queueName, job } of existingJobs) {
      if (!TERMINAL_JOB_STATES.has(job.state)) continue;
      await boss.deleteJob(queueName, job.id);
      deletedTerminalJobs += 1;
    }

    const jobId = await boss.send(
      KNOWLEDGE_DOCUMENT_QUEUE,
      { runId: input.runId, documentId: input.documentId },
      {
        id: input.runId,
        singletonKey: input.documentId,
        expireInSeconds: KNOWLEDGE_DOCUMENT_EXPIRE_SECONDS,
        heartbeatSeconds: KNOWLEDGE_DOCUMENT_HEARTBEAT_SECONDS,
        retryLimit: KNOWLEDGE_DOCUMENT_RETRY_LIMIT,
      },
    );
    if (jobId) {
      return { disposition: "recovered" as const, deletedTerminalJobs };
    }

    const concurrentJobs = await findKnowledgeDocumentJobs(boss, input.runId);
    if (
      concurrentJobs.some(({ job }) => NONTERMINAL_JOB_STATES.has(job.state))
    ) {
      return { disposition: "preserved" as const, deletedTerminalJobs };
    }
    throw new Error("The Knowledge document queue rejected the job.");
  });
}

export async function enqueueKnowledgeDocumentRun(input: {
  runId: string;
  documentId: string;
}) {
  await ensureKnowledgeDocumentRunQueued(input);
}

function environmentOperationJobOptions(
  operationId: string,
  retryLimit = ENVIRONMENT_OPERATION_RETRY_LIMIT,
) {
  return {
    retryLimit,
    retryDelay: ENVIRONMENT_OPERATION_RETRY_DELAY_SECONDS,
    retryBackoff: true,
    expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
    heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
    singletonKey: operationId,
  } as const;
}

export async function enqueueEnvironmentOperation(
  operationId: string,
  options: {
    retryLimit?: number | undefined;
  } = {},
) {
  const { prepareWorkspaceProvisionAdmission } =
    await import("@/lib/environments/dependency");
  if ((await prepareWorkspaceProvisionAdmission(operationId)) === "parked") {
    return;
  }
  const boss = await getKnowledgeBossProducer();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`environment-operation-queue:${operationId}`}, 0))`,
    );
    const existingJobs = await findEnvironmentOperationJobs(boss, operationId);
    if (existingJobs.some((job) => NONTERMINAL_JOB_STATES.has(job.state))) {
      return;
    }
    const jobId = await boss.send(
      ENVIRONMENT_OPERATION_QUEUE,
      { operationId },
      environmentOperationJobOptions(operationId, options.retryLimit),
    );
    if (jobId) return;
    const concurrentJobs = await findEnvironmentOperationJobs(
      boss,
      operationId,
    );
    if (
      concurrentJobs.some((job) => NONTERMINAL_JOB_STATES.has(job.state))
    ) {
      return;
    }
    throw new Error("The Environment operation queue rejected the job.");
  });
}

async function deferEnvironmentOperation(boss: PgBoss, operationId: string) {
  const operation = await knowledgeDb.query.environmentOperations.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.id, operationId), eq(table.status, "queued")),
    columns: {
      id: true,
      type: true,
      idempotencyKey: true,
      attempt: true,
      result: true,
    },
  });
  if (!operation) return;
  const retryLimit =
    operation.type === "workspace.backup" &&
    isDailyWorkspaceBackupIdempotencyKey(operation.idempotencyKey)
      ? Math.max(0, DAILY_BACKUP_MAX_ATTEMPTS - operation.attempt - 1)
      : ENVIRONMENT_OPERATION_RETRY_LIMIT;
  const jobId = await boss.send(
    ENVIRONMENT_OPERATION_QUEUE,
    { operationId },
    {
      retryLimit,
      retryDelay: ENVIRONMENT_OPERATION_RETRY_DELAY_SECONDS,
      retryBackoff: true,
      expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
      heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
      singletonKey: `${operationId}:deferred:${crypto.randomUUID()}`,
      startAfter: environmentOperationNextAttemptAt(operation.result),
    },
  );
  if (!jobId) {
    throw new Error("The Environment operation queue rejected the deferral.");
  }
}

function environmentOperationNextAttemptAt(result: unknown) {
  if (!(result && typeof result === "object")) {
    return new Date(
      Date.now() + ENVIRONMENT_OPERATION_RETRY_DELAY_SECONDS * 1000,
    );
  }
  const retryState = (result as Record<string, unknown>).retryState;
  if (!(retryState && typeof retryState === "object")) {
    return new Date(
      Date.now() + ENVIRONMENT_OPERATION_RETRY_DELAY_SECONDS * 1000,
    );
  }
  const value = (retryState as Record<string, unknown>).nextAttemptAt;
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return new Date(
    Number.isFinite(timestamp) ? Math.max(Date.now(), timestamp) : Date.now(),
  );
}

export async function enqueueOrganizationDeletion(operationId: string) {
  const boss = await getKnowledgeBossProducer();
  const jobId = await boss.send(
    ORGANIZATION_DELETION_QUEUE,
    { operationId },
    {
      retryLimit: 20,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
      heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
      singletonKey: operationId,
    },
  );
  if (!jobId)
    throw new Error("The organization deletion queue rejected the job.");
}

async function findEnvironmentOperationJobs(boss: PgBoss, operationId: string) {
  return boss.findJobs<{ operationId?: unknown }>(ENVIRONMENT_OPERATION_QUEUE, {
    data: { operationId },
  });
}

export async function reconcileEnvironmentOperationQueue(boss: PgBoss) {
  const {
    isParentOwnedWorkspaceBackup,
    reconcileTerminalWorkspaceBackupRecords,
  } = await import("@/lib/environments/backups");
  await reconcileTerminalWorkspaceBackupRecords();
  const { PROVISIONER_OPERATION_TYPES } =
    await import("@/lib/environments/operation-routing");
  const operations = await knowledgeDb.query.environmentOperations.findMany({
    where: (table, { and, inArray }) =>
      and(
        inArray(table.status, ["queued", "running"]),
        inArray(table.type, [
          ...PROVISIONER_OPERATION_TYPES,
          "workspace.backup",
        ]),
      ),
    columns: {
      id: true,
      status: true,
      type: true,
      input: true,
      idempotencyKey: true,
      attempt: true,
    },
    limit: 100,
  });
  for (const operation of operations) {
    const jobs = await findEnvironmentOperationJobs(boss, operation.id);
    if (jobs.some((job) => NONTERMINAL_JOB_STATES.has(job.state))) continue;
    if (
      operation.type === "workspace.backup" &&
      jobs.some((job) => job.state === "failed")
    ) {
      const { failExhaustedWorkspaceBackup } =
        await import("@/lib/environments/backups");
      await failExhaustedWorkspaceBackup(operation.id);
      continue;
    }
    if (
      operation.status === "running" &&
      operation.type === "workspace.backup"
    ) {
      if (isParentOwnedWorkspaceBackup(operation.input)) continue;
      const { failInterruptedWorkspaceBackup } =
        await import("@/lib/environments/backups");
      await failInterruptedWorkspaceBackup(operation.id);
      continue;
    }
    const retryLimit =
      operation.type === "workspace.backup" &&
      isDailyWorkspaceBackupIdempotencyKey(operation.idempotencyKey)
        ? Math.max(0, DAILY_BACKUP_MAX_ATTEMPTS - operation.attempt - 1)
        : undefined;
    await enqueueEnvironmentOperation(operation.id, { retryLimit });
  }
}

async function reconcileOrganizationDeletionQueue(boss: PgBoss) {
  const operations =
    await knowledgeDb.query.organizationDeletionOperations.findMany({
      where: (table, { inArray }) =>
        inArray(table.status, ["queued", "running"]),
      columns: { id: true },
      limit: 20,
    });
  for (const operation of operations) {
    const jobs = (
      await Promise.all(
        [
          LEGACY_ORGANIZATION_DELETION_QUEUE,
          LEGACY_ORGANIZATION_DELETION_QUEUE_V2,
          ORGANIZATION_DELETION_QUEUE,
        ].map((queueName) =>
          boss.findJobs<{ operationId?: unknown }>(queueName, {
            data: { operationId: operation.id },
          }),
        ),
      )
    ).flat();
    if (jobs.some((job) => NONTERMINAL_JOB_STATES.has(job.state))) continue;
    await enqueueOrganizationDeletion(operation.id);
  }
}

async function runEnvironmentMaintenance(boss: PgBoss) {
  if (environmentMaintenanceRunning) return;
  environmentMaintenanceRunning = true;
  try {
    await reconcileEnvironmentOperationQueue(boss);
    await reconcileOrganizationDeletionQueue(boss);
    const { interruptExpiredTurnWorkerCapacityOperation } =
      await import("@/lib/platform/turn-worker-capacity");
    await interruptExpiredTurnWorkerCapacityOperation();
  } finally {
    environmentMaintenanceRunning = false;
  }
}

async function processOrganizationDeletionJobs(
  jobs: Array<{ data?: { operationId?: unknown } }>,
) {
  const { processOrganizationDeletion } =
    await import("@/lib/organizations/deletion");
  for (const job of jobs) {
    if (typeof job.data?.operationId !== "string") continue;
    await processOrganizationDeletion(job.data.operationId);
  }
}

async function processKnowledgeDocumentJobs(
  jobs: Array<JobWithMetadata<KnowledgeDocumentJobData>>,
) {
  const next = knowledgeWorkerDrain.catch(() => {}).then(async () => {
    const { processKnowledgeDocumentRun } =
      await import("@/lib/knowledge/documents/process-runtime");
    for (const job of jobs) {
      if (typeof job.data?.runId !== "string") {
        throw new Error("Knowledge document job is missing a runId.");
      }
      try {
        await processKnowledgeDocumentRun(job.data.runId, {
          expectedDocumentId:
            typeof job.data.documentId === "string"
              ? job.data.documentId
              : undefined,
          finalAttempt: job.retryCount >= job.retryLimit,
        });
      } catch (error) {
        console.error("Knowledge document worker attempt failed.", {
          runId: job.data.runId,
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
          finalAttempt: job.retryCount >= job.retryLimit,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      }
    }
  });
  knowledgeWorkerDrain = next.catch(() => {});
  return next;
}

export async function reconcileKnowledgeDocumentQueue() {
  const boss = await getKnowledgeBossProducer();
  const runs = await knowledgeDb.query.knowledgeIngestionRuns.findMany({
    where: (table, { inArray }) =>
      inArray(table.status, ["queued", "running"]),
    columns: {
      id: true,
      documentId: true,
      createdAt: true,
    },
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
  });
  const summary = {
    scanned: 0,
    preserved: 0,
    recovered: 0,
    skipped: 0,
    deletedTerminalJobs: 0,
    oldestQueuedRunAgeMs: runs[0]
      ? Math.max(0, Date.now() - runs[0].createdAt.getTime())
      : 0,
  };

  for (let offset = 0; offset < runs.length; offset += 100) {
    const batch = runs.slice(offset, offset + 100);
    for (const run of batch) {
      const result = await ensureKnowledgeDocumentRunQueued({
        runId: run.id,
        documentId: run.documentId,
      });
      summary.scanned += 1;
      summary[result.disposition] += 1;
      summary.deletedTerminalJobs += result.deletedTerminalJobs;
    }
  }

  console.info("Knowledge document queue reconciliation completed.", summary);
  return summary;
}

async function runKnowledgeMaintenance() {
  if (knowledgeMaintenanceRunning) return;
  knowledgeMaintenanceRunning = true;
  try {
    await reconcileKnowledgeDocumentQueue();
  } finally {
    knowledgeMaintenanceRunning = false;
  }
}

export async function startKnowledgeDocumentWorker() {
  const boss = await getKnowledgeBossProducer();
  if (knowledgeQueueState.workersRegistered) return boss;
  const workOptions = {
    batchSize: 1,
    includeMetadata: true as const,
    heartbeatRefreshSeconds: KNOWLEDGE_DOCUMENT_HEARTBEAT_REFRESH_SECONDS,
  };
  await boss.work(
    KNOWLEDGE_DOCUMENT_QUEUE,
    workOptions,
    processKnowledgeDocumentJobs,
  );
  await boss.work(
    LEGACY_KNOWLEDGE_DOCUMENT_QUEUE,
    workOptions,
    processKnowledgeDocumentJobs,
  );
  knowledgeQueueState.workersRegistered = true;
  console.info("Knowledge document workers registered.", {
    queues: [KNOWLEDGE_DOCUMENT_QUEUE, LEGACY_KNOWLEDGE_DOCUMENT_QUEUE],
    concurrency: 1,
  });
  await reconcileKnowledgeDocumentQueue();
  knowledgeMaintenanceTimer = setInterval(() => {
    void runKnowledgeMaintenance().catch((error) => {
      console.error("Knowledge document queue reconciliation failed.", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    });
  }, KNOWLEDGE_DOCUMENT_RECONCILE_INTERVAL_MS);
  return boss;
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
      const { processEnvironmentOperation } =
        await import("@/lib/environments/process-runtime");
      for (const job of jobs) {
        if (typeof job.data?.operationId !== "string") continue;
        const result = await processEnvironmentOperation(job.data.operationId, {
          workerSignal: job.signal,
          workerAttempt: parseEnvironmentWorkerAttempt({
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
          }),
        });
        if (result === "deferred" || result === "not_claimed") {
          await deferEnvironmentOperation(boss, job.data.operationId);
        }
      }
    },
  );
  await boss.work(ORGANIZATION_DELETION_QUEUE, processOrganizationDeletionJobs);
  await boss.work(
    TURN_WORKER_CAPACITY_QUEUE,
    {
      batchSize: 1,
      includeMetadata: true,
      heartbeatRefreshSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_REFRESH_SECONDS,
    },
    async (jobs: Array<JobWithMetadata<{ operationId?: unknown }>>) => {
      const { processTurnWorkerCapacityOperation } =
        await import("@/lib/platform/turn-worker-capacity");
      for (const job of jobs) {
        if (typeof job.data?.operationId !== "string") continue;
        await processTurnWorkerCapacityOperation(job.data.operationId);
      }
    },
  );
  await boss.work(ENVIRONMENT_RECONCILE_QUEUE, async () => {
    const { runScheduledEnvironmentReconciliation } =
      await import("@/lib/environments/reconcile-schedule");
    await runScheduledEnvironmentReconciliation();
  });
  await boss.work(
    COST_PRICING_QUEUE,
    async (jobs: Array<{ data?: CostPricingJobData }>) => {
      const { backfillAuthoritativeUsage } =
        await import("@/lib/costs/metering");
      const { priceRecentUnpricedUsage, priceRecentlyUpdatedUsage } =
        await import("@/lib/costs/store");
      for (const job of jobs) {
        const backfill = job.data?.backfill;
        if (backfill !== "startup" && backfill !== "incremental") continue;
        const windowMs =
          backfill === "startup" ? 48 * 60 * 60 * 1000 : 15 * 60 * 1000;
        await backfillAuthoritativeUsage({
          since: new Date(Date.now() - windowMs),
        });
      }
      await priceRecentlyUpdatedUsage(new Date(Date.now() - 15 * 60 * 1000));
      await priceRecentUnpricedUsage();
    },
  );
  await boss.work(COST_ACCRUAL_QUEUE, async () => {
    const { accrueOrganizationFixedRates } =
      await import("@/lib/costs/metering");
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
    { singletonKey: "startup-backfill" },
  );
  await boss.send(COST_ACCRUAL_QUEUE, {}, { singletonKey: "startup-accrual" });
  await reconcileEnvironmentOperationQueue(boss);
  await reconcileOrganizationDeletionQueue(boss);
  const { interruptExpiredTurnWorkerCapacityOperation } =
    await import("@/lib/platform/turn-worker-capacity");
  await interruptExpiredTurnWorkerCapacityOperation();
  environmentMaintenanceTimer = setInterval(() => {
    void runEnvironmentMaintenance(boss).catch((error) => {
      console.error("Environment lifecycle worker maintenance failed.", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    });
  }, 5000);
  return boss;
}

export async function enqueueTurnWorkerCapacityOperation(operationId: string) {
  const boss = await getKnowledgeBossProducer();
  const jobId = await boss.send(
    TURN_WORKER_CAPACITY_QUEUE,
    { operationId },
    {
      singletonKey: operationId,
      retryLimit: 0,
      expireInSeconds: ENVIRONMENT_OPERATION_EXPIRE_SECONDS,
      heartbeatSeconds: ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS,
    },
  );
  if (!jobId) {
    throw new Error("The Turn Worker capacity queue rejected the operation.");
  }
}

async function stopControlWorkersOnce() {
  if (environmentMaintenanceTimer) {
    clearInterval(environmentMaintenanceTimer);
    environmentMaintenanceTimer = null;
  }
  if (knowledgeMaintenanceTimer) {
    clearInterval(knowledgeMaintenanceTimer);
    knowledgeMaintenanceTimer = null;
  }
  const bossPromise = knowledgeQueueState.bossPromise;
  try {
    if (bossPromise) {
      const boss = await bossPromise;
      await boss.stop({ graceful: true, timeout: 30_000 });
    }
  } finally {
    knowledgeQueueState.bossPromise = null;
    knowledgeQueueState.workersRegistered = false;
    knowledgeQueueState.environmentWorkersRegistered = false;
    knowledgeQueueState.managedRunPodWorkersRegistered = false;
    environmentMaintenanceRunning = false;
    knowledgeMaintenanceRunning = false;
    knowledgeWorkerDrain = Promise.resolve();
  }
}

export async function stopControlWorkers() {
  if (controlWorkersStopPromise) return controlWorkersStopPromise;
  controlWorkersStopPromise = stopControlWorkersOnce();
  try {
    await controlWorkersStopPromise;
  } finally {
    controlWorkersStopPromise = null;
  }
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
  ORGANIZATION_DELETION_QUEUE,
  ENVIRONMENT_RECONCILE_QUEUE,
  MANAGED_RUNPOD_RECONCILE_QUEUE,
  MANAGED_RUNPOD_RUN_QUEUE,
  MANAGED_RUNPOD_USAGE_QUEUE,
};
