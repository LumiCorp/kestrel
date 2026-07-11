import { PgBoss } from "pg-boss";
import { KNOWLEDGE_DOCUMENT_QUEUE } from "@/lib/knowledge/documents/constants";
import { processKnowledgeDocumentRun } from "@/lib/knowledge/documents/runtime";
import { processKnowledgeSyncRun } from "@/lib/knowledge/sync-runtime";

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const KNOWLEDGE_SYNC_QUEUE = "knowledge.sync";

let bossPromise: Promise<PgBoss> | null = null;
let workersRegistered = false;

async function createBoss() {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }

  const boss = new PgBoss({
    connectionString: databaseUrl,
    migrate: true,
  });

  await boss.start();
  await boss.createQueue(KNOWLEDGE_SYNC_QUEUE);
  await boss.createQueue(KNOWLEDGE_DOCUMENT_QUEUE);
  return boss;
}

export async function getKnowledgeBoss() {
  if (!bossPromise) {
    bossPromise = createBoss();
  }

  const boss = await bossPromise;
  if (!workersRegistered) {
    workersRegistered = true;
    await boss.work(
      KNOWLEDGE_SYNC_QUEUE,
      async (jobs: Array<{ data?: unknown }>) => {
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

export async function getKnowledgeQueueStatus() {
  if (!databaseUrl) {
    return {
      configured: false,
      available: false,
      workerRegistered: false,
      error: "DATABASE_URL or POSTGRES_URL is required",
    };
  }

  if (!bossPromise) {
    return {
      configured: true,
      available: true,
      workerRegistered: workersRegistered,
      error: null,
    };
  }

  try {
    await bossPromise;
    return {
      configured: true,
      available: true,
      workerRegistered: workersRegistered,
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      workerRegistered: workersRegistered,
      error:
        error instanceof Error ? error.message : "Failed to initialize pg-boss",
    };
  }
}

export { KNOWLEDGE_SYNC_QUEUE };
