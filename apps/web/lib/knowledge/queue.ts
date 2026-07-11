import { PgBoss } from "pg-boss";
import { KNOWLEDGE_DOCUMENT_QUEUE } from "@/lib/knowledge/documents/constants";
import { knowledgeQueueState } from "@/lib/knowledge/queue-state";

const KNOWLEDGE_SYNC_QUEUE = "knowledge.sync";

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

export { KNOWLEDGE_SYNC_QUEUE };
