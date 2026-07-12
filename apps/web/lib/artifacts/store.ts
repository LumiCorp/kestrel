import { and, asc, eq, gt } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type {
  DbArtifactDocument,
  DbArtifactSuggestion,
  NewDbArtifactSuggestion,
} from "@/lib/knowledge/db-types";
import { getThreadForUser } from "@/lib/threads/store";

export async function saveArtifactDocument(input: {
  id: string;
  title: string;
  kind: "text" | "code" | "image" | "sheet" | "video";
  content: string;
  userId: string;
  organizationId: string;
  threadId?: string | null;
}) {
  if (
    input.threadId &&
    !(await getThreadForUser(
      input.threadId,
      input.userId,
      input.organizationId
    ))
  ) {
    throw new Error("Thread not found");
  }
  const [document] = await knowledgeDb
    .insert(schema.artifactDocuments)
    .values({
      id: input.id,
      title: input.title,
      kind: input.kind,
      content: input.content,
      userId: input.userId,
      organizationId: input.organizationId,
      threadId: input.threadId ?? null,
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
  const documents = await knowledgeDb.query.artifactDocuments.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.id),
        eq(table.organizationId, input.organizationId)
      ),
    orderBy: (table) => [asc(table.createdAt)],
  });
  const accessByThreadId = new Map<string, boolean>();
  const authorized = [];
  for (const document of documents) {
    if (!document.threadId) {
      if (document.userId === input.userId) authorized.push(document);
      continue;
    }
    let hasAccess = accessByThreadId.get(document.threadId);
    if (hasAccess === undefined) {
      hasAccess = Boolean(
        await getThreadForUser(
          document.threadId,
          input.userId,
          input.organizationId,
          true
        )
      );
      accessByThreadId.set(document.threadId, hasAccess);
    }
    if (hasAccess) authorized.push(document);
  }
  return authorized;
}

export async function getLatestArtifactDocumentById(input: {
  id: string;
  userId: string;
  organizationId: string;
}) {
  const documents = await getArtifactDocumentsById(input);
  return documents.at(-1);
}

export async function deleteArtifactDocumentsByIdAfterTimestamp(input: {
  id: string;
  timestamp: Date;
  userId: string;
  organizationId: string;
}) {
  const documents = await getArtifactDocumentsById(input);
  if (documents.length === 0) {
    return [];
  }
  await knowledgeDb
    .delete(schema.artifactSuggestions)
    .where(
      and(
        eq(schema.artifactSuggestions.documentId, input.id),
        eq(schema.artifactSuggestions.organizationId, input.organizationId),
        gt(schema.artifactSuggestions.documentCreatedAt, input.timestamp)
      )
    );

  return knowledgeDb
    .delete(schema.artifactDocuments)
    .where(
      and(
        eq(schema.artifactDocuments.id, input.id),
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
  const documents = await getArtifactDocumentsById({
    id: input.documentId,
    userId: input.userId,
    organizationId: input.organizationId,
  });
  if (documents.length === 0) {
    return [];
  }
  return knowledgeDb.query.artifactSuggestions.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.documentId, input.documentId),
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
