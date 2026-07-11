import { and, eq, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export async function createKnowledgeSnapshot(input: {
  organizationId: string;
  filesystemPath: string;
  status?: "building" | "ready" | "failed" | "stale";
  metadata?: Record<string, unknown> | null;
}) {
  const [snapshot] = await knowledgeDb
    .insert(schema.knowledgeSnapshots)
    .values({
      organizationId: input.organizationId,
      filesystemPath: input.filesystemPath,
      status: input.status ?? "building",
      metadata: input.metadata ?? null,
      sourceCount: 0,
      fileCount: 0,
      isActive: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return snapshot;
}

export async function getKnowledgeSnapshotById(
  organizationId: string,
  snapshotId: string
) {
  return knowledgeDb.query.knowledgeSnapshots.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.id, snapshotId), eq(table.organizationId, organizationId)),
  });
}

export async function getActiveKnowledgeSnapshot(organizationId: string) {
  return knowledgeDb.query.knowledgeSnapshots.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.organizationId, organizationId), eq(table.isActive, true)),
    orderBy: (table, { desc }) => [desc(table.updatedAt)],
  });
}

export async function getLatestReadyKnowledgeSnapshot(organizationId: string) {
  return knowledgeDb.query.knowledgeSnapshots.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.organizationId, organizationId), eq(table.status, "ready")),
    orderBy: (table, { desc }) => [desc(table.updatedAt)],
  });
}

export async function listKnowledgeSnapshots(
  organizationId: string,
  limit = 20
) {
  return knowledgeDb.query.knowledgeSnapshots.findMany({
    where: (table, { eq }) => eq(table.organizationId, organizationId),
    orderBy: (table, { desc }) => [desc(table.updatedAt)],
    limit,
  });
}

export async function updateKnowledgeSnapshot(
  snapshotId: string,
  patch: Partial<typeof schema.knowledgeSnapshots.$inferInsert>
) {
  const [snapshot] = await knowledgeDb
    .update(schema.knowledgeSnapshots)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(schema.knowledgeSnapshots.id, snapshotId))
    .returning();
  return snapshot;
}

export async function markSnapshotActive(
  organizationId: string,
  snapshotId: string
) {
  await knowledgeDb
    .update(schema.knowledgeSnapshots)
    .set({
      isActive: false,
      updatedAt: new Date(),
    })
    .where(eq(schema.knowledgeSnapshots.organizationId, organizationId));

  const [snapshot] = await knowledgeDb
    .update(schema.knowledgeSnapshots)
    .set({
      isActive: true,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.knowledgeSnapshots.id, snapshotId),
        eq(schema.knowledgeSnapshots.organizationId, organizationId)
      )
    )
    .returning();

  return snapshot;
}

export async function getSnapshotStats(organizationId: string) {
  const [result] = await knowledgeDb
    .select({
      total: sql<number>`count(*)::int`,
    })
    .from(schema.knowledgeSnapshots)
    .where(eq(schema.knowledgeSnapshots.organizationId, organizationId));

  return Number(result?.total ?? 0);
}
