import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { KNOWLEDGE_DOCUMENT_QUEUE } from "@/lib/knowledge/documents/constants";
import { knowledgeQueueState } from "@/lib/knowledge/queue-state";

const KNOWLEDGE_SYNC_QUEUE = "knowledge.sync";
const MANAGED_RUNPOD_RUN_QUEUE = "ai.runpod.run";
const MANAGED_RUNPOD_RECONCILE_QUEUE = "ai.runpod.reconcile";
const MANAGED_RUNPOD_USAGE_QUEUE = "ai.runpod.usage";
const MANAGED_RUNPOD_RUN_OPTIONS = {
  retryLimit: 20,
  retryDelay: 15,
  retryBackoff: true,
} as const;

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
  await boss.createQueue(KNOWLEDGE_SYNC_QUEUE);
  await boss.createQueue(KNOWLEDGE_DOCUMENT_QUEUE);
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
      KNOWLEDGE_SYNC_QUEUE,
      async (jobs: Array<{ data?: unknown }>) => {
        const { processKnowledgeSyncRun } = await import(
          "@/lib/knowledge/sync-runtime"
        );
        for (const job of jobs) {
          const payload = job.data as { runId?: string } | null;
          if (payload?.runId) {
            await processKnowledgeSyncRun(payload.runId);
          }
        }
      }
    );
    await boss.work(
      MANAGED_RUNPOD_RUN_QUEUE,
      async (jobs: Array<{ data?: unknown }>) => {
        const { processManagedRunPodRun } = await import(
          "@/lib/ai/managed-runpod-runtime"
        );
        for (const job of jobs) {
          const payload = job.data as { runId?: string } | null;
          if (payload?.runId) {
            await processManagedRunPodRun(payload.runId);
          }
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

export async function enqueueKnowledgeSyncRun(runId: string) {
  const boss = await getKnowledgeBoss();
  await boss.send(KNOWLEDGE_SYNC_QUEUE, { runId });
}

export async function enqueueKnowledgeDocumentRun(runId: string) {
  const boss = await getKnowledgeBoss();
  await boss.send(KNOWLEDGE_DOCUMENT_QUEUE, { runId });
}

export async function enqueueManagedRunPodRun(runId: string) {
  const boss = await getKnowledgeBoss();
  await sendManagedRunPodRun(boss, runId);
}

export async function enqueueManagedRunPodReconciliation() {
  const boss = await getKnowledgeBoss();
  await boss.send(MANAGED_RUNPOD_RECONCILE_QUEUE, {});
}

export async function enqueueManagedRunPodUsageIngestion() {
  const boss = await getKnowledgeBoss();
  await boss.send(MANAGED_RUNPOD_USAGE_QUEUE, {});
}

export {
  KNOWLEDGE_SYNC_QUEUE,
  MANAGED_RUNPOD_RECONCILE_QUEUE,
  MANAGED_RUNPOD_RUN_QUEUE,
  MANAGED_RUNPOD_USAGE_QUEUE,
};
