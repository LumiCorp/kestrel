import { PgBoss } from "pg-boss";
import { KNOWLEDGE_DOCUMENT_QUEUE } from "@/lib/knowledge/documents/constants";
import { knowledgeQueueState } from "@/lib/knowledge/queue-state";

const KNOWLEDGE_SYNC_QUEUE = "knowledge.sync";
const ENVIRONMENT_OPERATION_QUEUE = "environment.operation";
const ENVIRONMENT_RECONCILE_QUEUE = "environment.reconcile";

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
  await boss.createQueue(ENVIRONMENT_OPERATION_QUEUE);
  await boss.createQueue(ENVIRONMENT_RECONCILE_QUEUE);
  await boss.schedule(ENVIRONMENT_RECONCILE_QUEUE, "*/5 * * * *", {});
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
    await boss.work(
      ENVIRONMENT_OPERATION_QUEUE,
      async (jobs: Array<{ data?: unknown }>) => {
        const { processEnvironmentOperation } = await import(
          "@/lib/environments/process-runtime"
        );
        for (const job of jobs) {
          const payload = job.data as { operationId?: string } | null;
          if (payload?.operationId) {
            await processEnvironmentOperation(payload.operationId);
          }
        }
      }
    );
    await boss.work(ENVIRONMENT_RECONCILE_QUEUE, async () => {
      const { reconcileHostedEnvironments } = await import(
        "@/lib/environments/reconcile"
      );
      await reconcileHostedEnvironments();
    });
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

export async function enqueueEnvironmentOperation(operationId: string) {
  const boss = await getKnowledgeBoss();
  await boss.send(
    ENVIRONMENT_OPERATION_QUEUE,
    { operationId },
    { retryLimit: 20, retryDelay: 3, retryBackoff: true }
  );
}

export {
  ENVIRONMENT_OPERATION_QUEUE,
  ENVIRONMENT_RECONCILE_QUEUE,
  KNOWLEDGE_SYNC_QUEUE,
};
