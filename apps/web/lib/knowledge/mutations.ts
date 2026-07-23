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
