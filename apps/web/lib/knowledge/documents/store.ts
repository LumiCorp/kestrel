import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { isAdminUser } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export function getKnowledgeDocumentsForOrganization(organizationId: string) {
  return knowledgeDb
    .select({
      id: schema.knowledgeDocuments.id,
      organizationId: schema.knowledgeDocuments.organizationId,
      uploaderUserId: schema.knowledgeDocuments.uploaderUserId,
      title: schema.knowledgeDocuments.title,
      filename: schema.knowledgeDocuments.filename,
      originalFilename: schema.knowledgeDocuments.originalFilename,
      mediaType: schema.knowledgeDocuments.mediaType,
      sizeBytes: schema.knowledgeDocuments.sizeBytes,
      status: schema.knowledgeDocuments.status,
      pageCount: schema.knowledgeDocuments.pageCount,
      chunkCount: schema.knowledgeDocuments.chunkCount,
      extractionMetadata: schema.knowledgeDocuments.extractionMetadata,
      error: schema.knowledgeDocuments.error,
      createdAt: schema.knowledgeDocuments.createdAt,
      updatedAt: schema.knowledgeDocuments.updatedAt,
      uploaderName: schema.users.name,
      uploaderEmail: schema.users.email,
    })
    .from(schema.knowledgeDocuments)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.knowledgeDocuments.uploaderUserId)
    )
    .where(
      and(
        eq(schema.knowledgeDocuments.organizationId, organizationId),
        eq(schema.knowledgeDocuments.scope, "organization"),
        isNull(schema.knowledgeDocuments.projectId),
        isNull(schema.knowledgeDocuments.archivedAt)
      )
    )
    .orderBy(desc(schema.knowledgeDocuments.createdAt));
}

export function getKnowledgeDocumentById(
  organizationId: string,
  documentId: string
) {
  return knowledgeDb.query.knowledgeDocuments.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.id, documentId),
        operators.eq(table.organizationId, organizationId)
      ),
  });
}

export function getKnowledgeDocumentByChecksum(
  organizationId: string,
  checksumSha256: string,
  projectId?: string | null
) {
  return knowledgeDb.query.knowledgeDocuments.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.organizationId, organizationId),
        operators.eq(table.checksumSha256, checksumSha256),
        projectId
          ? operators.eq(table.projectId, projectId)
          : operators.and(
              operators.eq(table.scope, "organization"),
              operators.isNull(table.projectId)
            )
      ),
    orderBy: (table, operators) => [operators.desc(table.updatedAt)],
  });
}

export async function createKnowledgeDocument(input: {
  id: string;
  organizationId: string;
  uploaderUserId: string;
  title?: string | null;
  filename: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  checksumSha256: string;
  storageKey: string;
  projectId?: string | null;
}) {
  const [document] = await knowledgeDb
    .insert(schema.knowledgeDocuments)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      scope: input.projectId ? "project" : "organization",
      projectId: input.projectId ?? null,
      uploaderUserId: input.uploaderUserId,
      title: input.title ?? null,
      filename: input.filename,
      originalFilename: input.originalFilename,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
      storageKey: input.storageKey,
      status: "uploaded",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return document;
}

export async function updateKnowledgeDocument(
  documentId: string,
  values: Partial<typeof schema.knowledgeDocuments.$inferInsert>
) {
  const [document] = await knowledgeDb
    .update(schema.knowledgeDocuments)
    .set({
      ...values,
      updatedAt: new Date(),
    })
    .where(eq(schema.knowledgeDocuments.id, documentId))
    .returning();

  return document;
}

export async function deleteKnowledgeDocument(documentId: string) {
  const [document] = await knowledgeDb
    .delete(schema.knowledgeDocuments)
    .where(eq(schema.knowledgeDocuments.id, documentId))
    .returning();

  return document;
}

export async function createKnowledgeIngestionRun(input: {
  organizationId: string;
  documentId: string;
  requestedByUserId?: string | null;
}) {
  const [run] = await knowledgeDb
    .insert(schema.knowledgeIngestionRuns)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      documentId: input.documentId,
      requestedByUserId: input.requestedByUserId ?? null,
      stage: "upload",
      status: "queued",
      attemptCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return run;
}

export function getKnowledgeIngestionRun(runId: string) {
  return knowledgeDb.query.knowledgeIngestionRuns.findFirst({
    where: (table, operators) => operators.eq(table.id, runId),
  });
}

export async function getLatestKnowledgeIngestionRunsForDocuments(
  documentIds: string[]
) {
  if (documentIds.length === 0) {
    return new Map<string, typeof schema.knowledgeIngestionRuns.$inferSelect>();
  }

  const runs = await knowledgeDb
    .select()
    .from(schema.knowledgeIngestionRuns)
    .where(inArray(schema.knowledgeIngestionRuns.documentId, documentIds))
    .orderBy(
      desc(schema.knowledgeIngestionRuns.updatedAt),
      desc(schema.knowledgeIngestionRuns.createdAt)
    );

  const latestRuns = new Map<
    string,
    typeof schema.knowledgeIngestionRuns.$inferSelect
  >();

  for (const run of runs) {
    if (!latestRuns.has(run.documentId)) {
      latestRuns.set(run.documentId, run);
    }
  }

  return latestRuns;
}

export async function getVisibleProjectUsageForKnowledgeDocuments(input: {
  organizationId: string;
  userId: string;
  documentIds: string[];
}) {
  if (input.documentIds.length === 0) {
    return new Map<string, Array<{ id: string; name: string }>>();
  }

  const rows = await knowledgeDb
    .select({
      documentId: schema.projectContextDocuments.documentId,
      projectId: schema.projects.id,
      projectName: schema.projects.name,
    })
    .from(schema.projectContextDocuments)
    .innerJoin(
      schema.projectContextRevisions,
      eq(
        schema.projectContextRevisions.id,
        schema.projectContextDocuments.contextRevisionId
      )
    )
    .innerJoin(
      schema.projects,
      and(
        eq(schema.projects.id, schema.projectContextRevisions.projectId),
        eq(
          schema.projects.currentContextRevision,
          schema.projectContextRevisions.revision
        ),
        isNull(schema.projects.archivedAt)
      )
    )
    .innerJoin(
      schema.projectMembers,
      eq(schema.projectMembers.projectId, schema.projects.id)
    )
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.id, schema.projectMembers.organizationMemberId),
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.userId)
      )
    )
    .where(
      inArray(schema.projectContextDocuments.documentId, input.documentIds)
    );

  const usage = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of rows) {
    const projects = usage.get(row.documentId) ?? [];
    if (!projects.some((project) => project.id === row.projectId)) {
      projects.push({ id: row.projectId, name: row.projectName });
    }
    usage.set(row.documentId, projects);
  }
  return usage;
}

export async function updateKnowledgeIngestionRun(
  runId: string,
  values: Partial<typeof schema.knowledgeIngestionRuns.$inferInsert>
) {
  const [run] = await knowledgeDb
    .update(schema.knowledgeIngestionRuns)
    .set({
      ...values,
      updatedAt: new Date(),
    })
    .where(eq(schema.knowledgeIngestionRuns.id, runId))
    .returning();

  return run;
}

export async function replaceKnowledgeDocumentChunks(input: {
  organizationId: string;
  documentId: string;
  chunks: Omit<
    typeof schema.knowledgeDocumentChunks.$inferInsert,
    "id" | "organizationId" | "documentId" | "createdAt"
  >[];
}) {
  await knowledgeDb
    .delete(schema.knowledgeDocumentChunks)
    .where(eq(schema.knowledgeDocumentChunks.documentId, input.documentId));

  if (input.chunks.length === 0) {
    return [];
  }

  return knowledgeDb
    .insert(schema.knowledgeDocumentChunks)
    .values(
      input.chunks.map((chunk) => ({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        documentId: input.documentId,
        ...chunk,
        createdAt: new Date(),
      }))
    )
    .returning();
}

export async function getReadyKnowledgeDocumentCount(organizationId: string) {
  const documents = await knowledgeDb.query.knowledgeDocuments.findMany({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.organizationId, organizationId),
        operators.inArray(table.status, ["ready", "partial"])
      ),
    columns: {
      id: true,
      filename: true,
      title: true,
    },
    orderBy: (table) => [asc(table.createdAt)],
    limit: 5,
  });

  return {
    count: documents.length,
    labels: documents.map((document) => document.title || document.filename),
  };
}

export function canManageKnowledgeDocument(
  document: {
    uploaderUserId: string;
  },
  user: { id?: string | null; role?: string | null }
) {
  return document.uploaderUserId === user.id || isAdminUser(user);
}

export async function deleteKnowledgeDocumentGraph(documentId: string) {
  // Deletion is immediate: remove every context reference before deleting the
  // document itself, so a formerly curated organization document cannot remain
  // retrievable through an existing Project revision.
  await knowledgeDb
    .delete(schema.projectContextDocuments)
    .where(eq(schema.projectContextDocuments.documentId, documentId));
  await knowledgeDb
    .delete(schema.knowledgeIngestionRuns)
    .where(eq(schema.knowledgeIngestionRuns.documentId, documentId));
  await knowledgeDb
    .delete(schema.knowledgeDocumentChunks)
    .where(eq(schema.knowledgeDocumentChunks.documentId, documentId));
  return deleteKnowledgeDocument(documentId);
}
