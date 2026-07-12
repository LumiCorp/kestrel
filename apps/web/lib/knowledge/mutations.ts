import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { requireKnowledgeDocumentAccess } from "@/lib/knowledge/documents/access";
import {
  createKnowledgeDocumentFromUpload,
  queueKnowledgeDocumentReindex,
  removeKnowledgeDocument,
} from "@/lib/knowledge/documents/runtime";
import {
  isKnowledgeDocumentMediaTypeSupported,
  normalizeMediaType,
} from "@/lib/knowledge/documents/shared";

export const MAX_KNOWLEDGE_FILE_BYTES = 32 * 1024 * 1024;

export const createSourceSchema = z.object({
  type: z.enum(["github", "youtube"]),
  label: z.string().min(1),
  basePath: z.string().optional().default("/docs"),
  repo: z.string().optional(),
  branch: z.string().optional().default("main"),
  contentPath: z.string().optional(),
  outputPath: z.string().optional(),
  readmeOnly: z.boolean().optional().default(false),
  channelId: z.string().optional(),
  handle: z.string().optional(),
  maxVideos: z.number().optional().default(50),
});

export const updateSourceSchema = z.object({
  label: z.string().min(1).optional(),
  basePath: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  contentPath: z.string().optional(),
  outputPath: z.string().optional(),
  readmeOnly: z.boolean().optional(),
  channelId: z.string().optional(),
  handle: z.string().optional(),
  maxVideos: z.number().optional(),
});

export async function createKnowledgeSource(input: {
  actorUserId: string;
  body: z.infer<typeof createSourceSchema>;
  organizationId: string;
}) {
  const [source] = await knowledgeDb
    .insert(schema.sources)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      type: input.body.type,
      label: input.body.label,
      basePath: input.body.basePath,
      repo: input.body.repo,
      branch: input.body.branch,
      contentPath: input.body.contentPath,
      outputPath: input.body.outputPath,
      readmeOnly: input.body.readmeOnly,
      channelId: input.body.channelId,
      handle: input.body.handle,
      maxVideos: input.body.maxVideos,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "sources",
    action: "create",
    targetType: "source",
    targetId: source.id,
    message: `Created ${input.body.type} source ${input.body.label}.`,
    metadata: {
      type: input.body.type,
      label: input.body.label,
    },
  });

  return source;
}

export async function updateKnowledgeSource(input: {
  actorUserId: string;
  body: z.infer<typeof updateSourceSchema>;
  organizationId: string;
  sourceId: string;
}) {
  const [source] = await knowledgeDb
    .update(schema.sources)
    .set({
      ...input.body,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.sources.id, input.sourceId),
        eq(schema.sources.organizationId, input.organizationId)
      )
    )
    .returning();

  if (!source) {
    throw new Error("Source not found");
  }

  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "sources",
    action: "update",
    targetType: "source",
    targetId: source.id,
    message: `Updated source ${source.label}.`,
    metadata: input.body,
  });

  return source;
}

export async function deleteKnowledgeSource(input: {
  actorUserId: string;
  organizationId: string;
  sourceId: string;
}) {
  const [deleted] = await knowledgeDb
    .delete(schema.sources)
    .where(
      and(
        eq(schema.sources.id, input.sourceId),
        eq(schema.sources.organizationId, input.organizationId)
      )
    )
    .returning();

  if (!deleted) {
    throw new Error("Source not found");
  }

  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    level: "warn",
    category: "sources",
    action: "delete",
    targetType: "source",
    targetId: deleted.id,
    message: `Deleted source ${deleted.label}.`,
    metadata: {
      type: deleted.type,
    },
  });

  return deleted;
}

export async function uploadKnowledgeDocumentForUser(input: {
  file: File;
  organizationId: string;
  uploaderUserId: string;
  projectId?: string | null;
}) {
  const mediaType = normalizeMediaType(input.file.type, input.file.name);

  if (!isKnowledgeDocumentMediaTypeSupported(mediaType, input.file.name)) {
    throw new Error(
      `File type ${mediaType} is not supported for knowledge uploads`
    );
  }

  if (input.file.size > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new Error("File size exceeds 32MB limit");
  }

  return createKnowledgeDocumentFromUpload(input);
}

export async function reindexKnowledgeDocumentForUser(input: {
  actorUser: { id?: string | null; role?: string | null };
  organizationId: string;
  requestedByUserId: string;
  documentId: string;
}) {
  const document = await requireKnowledgeDocumentAccess({
    organizationId: input.organizationId,
    user: {
      id: input.requestedByUserId,
      role: input.actorUser.role,
    },
    documentId: input.documentId,
    manage: true,
  });

  const run = await queueKnowledgeDocumentReindex({
    organizationId: input.organizationId,
    documentId: document.id,
    requestedByUserId: input.requestedByUserId,
  });

  return {
    run,
    message: `Reindex started for ${document.filename}.`,
  };
}

export async function deleteKnowledgeDocumentForUser(input: {
  actorUser: { id?: string | null; role?: string | null };
  actorUserId: string;
  organizationId: string;
  documentId: string;
}) {
  const document = await requireKnowledgeDocumentAccess({
    organizationId: input.organizationId,
    user: { id: input.actorUserId, role: input.actorUser.role },
    documentId: input.documentId,
    manage: true,
  });

  await removeKnowledgeDocument({
    organizationId: input.organizationId,
    documentId: document.id,
    actorUserId: input.actorUserId,
  });

  return document;
}
