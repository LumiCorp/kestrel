import { and, asc, desc, eq, gt } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type {
  DbArtifactDocument,
  DbArtifactSuggestion,
  NewDbArtifactSuggestion,
} from "@/lib/knowledge/db-types";

export async function saveArtifactDocument(input: {
  id: string;
  title: string;
  kind: "text" | "code" | "image" | "sheet" | "video";
  content: string;
  userId: string;
  organizationId: string;
  chatId?: string | null;
}) {
  const [document] = await knowledgeDb
    .insert(schema.artifactDocuments)
    .values({
      id: input.id,
      title: input.title,
      kind: input.kind,
      content: input.content,
      userId: input.userId,
      organizationId: input.organizationId,
      chatId: input.chatId ?? null,
      createdAt: new Date(),
    })
    .returning();

  return document;
}

export async function getArtifactDocumentsById(input: {
  id: string;
  userId: string;
  organizationId: string;
}) {
  return knowledgeDb.query.artifactDocuments.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.id),
        eq(table.userId, input.userId),
        eq(table.organizationId, input.organizationId)
      ),
    orderBy: (table) => [asc(table.createdAt)],
  });
}

export async function getLatestArtifactDocumentById(input: {
  id: string;
  userId: string;
  organizationId: string;
}) {
  return knowledgeDb.query.artifactDocuments.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.id),
        eq(table.userId, input.userId),
        eq(table.organizationId, input.organizationId)
      ),
    orderBy: (table) => [desc(table.createdAt)],
  });
}

export async function deleteArtifactDocumentsByIdAfterTimestamp(input: {
  id: string;
  timestamp: Date;
  userId: string;
  organizationId: string;
}) {
  await knowledgeDb
    .delete(schema.artifactSuggestions)
    .where(
      and(
        eq(schema.artifactSuggestions.documentId, input.id),
        eq(schema.artifactSuggestions.userId, input.userId),
        eq(schema.artifactSuggestions.organizationId, input.organizationId),
        gt(schema.artifactSuggestions.documentCreatedAt, input.timestamp)
      )
    );

  return knowledgeDb
    .delete(schema.artifactDocuments)
    .where(
      and(
        eq(schema.artifactDocuments.id, input.id),
        eq(schema.artifactDocuments.userId, input.userId),
        eq(schema.artifactDocuments.organizationId, input.organizationId),
        gt(schema.artifactDocuments.createdAt, input.timestamp)
      )
    )
    .returning();
}

export async function saveArtifactSuggestions(input: {
  suggestions: NewDbArtifactSuggestion[];
}) {
  if (input.suggestions.length === 0) {
    return [];
  }

  return knowledgeDb
    .insert(schema.artifactSuggestions)
    .values(input.suggestions)
    .returning();
}

export async function getArtifactSuggestionsByDocumentId(input: {
  documentId: string;
  userId: string;
  organizationId: string;
}): Promise<DbArtifactSuggestion[]> {
  return knowledgeDb.query.artifactSuggestions.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.documentId, input.documentId),
        eq(table.userId, input.userId),
        eq(table.organizationId, input.organizationId)
      ),
    orderBy: (table) => [asc(table.createdAt)],
  });
}

export function asArtifactDocumentVersion(
  document: DbArtifactDocument
): DbArtifactDocument {
  return document;
}
