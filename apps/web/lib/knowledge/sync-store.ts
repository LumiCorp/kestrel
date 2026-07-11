import { eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export async function createKnowledgeSyncRun(input: {
  organizationId: string;
  requestedByUserId?: string | null;
  sourceFilter?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const [run] = await knowledgeDb
    .insert(schema.knowledgeSyncRuns)
    .values({
      organizationId: input.organizationId,
      requestedByUserId: input.requestedByUserId ?? null,
      sourceFilter: input.sourceFilter ?? null,
      status: "queued",
      metadata: input.metadata ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return run;
}

export async function getKnowledgeSyncRun(
  organizationId: string,
  runId: string
) {
  return knowledgeDb.query.knowledgeSyncRuns.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.id, runId), eq(table.organizationId, organizationId)),
  });
}

export async function getLatestKnowledgeSyncRun(organizationId: string) {
  return knowledgeDb.query.knowledgeSyncRuns.findFirst({
    where: (table, { eq }) => eq(table.organizationId, organizationId),
    orderBy: (table, { desc }) => [desc(table.updatedAt)],
  });
}

export async function listKnowledgeSyncRuns(
  organizationId: string,
  limit = 20
) {
  return knowledgeDb.query.knowledgeSyncRuns.findMany({
    where: (table, { eq }) => eq(table.organizationId, organizationId),
    orderBy: (table, { desc }) => [desc(table.updatedAt)],
    limit,
  });
}

export async function updateKnowledgeSyncRun(
  runId: string,
  patch: Partial<typeof schema.knowledgeSyncRuns.$inferInsert>
) {
  const [run] = await knowledgeDb
    .update(schema.knowledgeSyncRuns)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(schema.knowledgeSyncRuns.id, runId))
    .returning();
  return run;
}
