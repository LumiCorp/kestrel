import type { PgBoss } from "pg-boss";

export const knowledgeQueueState = {
  databaseUrl: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  bossPromise: null as Promise<PgBoss> | null,
  workersRegistered: false,
};

export async function getKnowledgeQueueStatus() {
  if (!knowledgeQueueState.databaseUrl) {
    return {
      configured: false,
      available: false,
      workerRegistered: false,
      error: "DATABASE_URL or POSTGRES_URL is required",
    };
  }

  if (!knowledgeQueueState.bossPromise) {
    return {
      configured: true,
      available: true,
      workerRegistered: knowledgeQueueState.workersRegistered,
      error: null,
    };
  }

  try {
    await knowledgeQueueState.bossPromise;
    return {
      configured: true,
      available: true,
      workerRegistered: knowledgeQueueState.workersRegistered,
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      workerRegistered: knowledgeQueueState.workersRegistered,
      error:
        error instanceof Error ? error.message : "Failed to initialize pg-boss",
    };
  }
}
