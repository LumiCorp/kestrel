import { createHash } from "node:crypto";
import { logAdminEvent } from "@/lib/admin/logs";
import { readUpload } from "@/lib/files/storage";
import { assertUploadPathOwnedByUser } from "@/lib/files/upload-path";
import { enqueueKnowledgeDocumentRun } from "@/lib/knowledge/queue";
import { getStorageAdapter } from "@/lib/storage";
import { buildKnowledgeDocumentObjectKey, normalizeMediaType } from "./shared";
import {
  createKnowledgeDocument,
  createKnowledgeIngestionRun,
  deleteKnowledgeDocumentGraph,
  getKnowledgeDocumentByChecksum,
  getKnowledgeDocumentById,
} from "./store";

function isChecksumConflict(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("knowledge_documents_org_checksum_idx") ||
    error.message.includes("duplicate key")
  );
}

export async function createKnowledgeDocumentFromUpload(input: {
  organizationId: string;
  uploaderUserId: string;
  projectId?: string | null;
  file: File;
}) {
  const mediaType = normalizeMediaType(input.file.type, input.file.name);
  const buffer = Buffer.from(await input.file.arrayBuffer());
  return createKnowledgeDocumentFromBuffer({
    organizationId: input.organizationId,
    uploaderUserId: input.uploaderUserId,
    projectId: input.projectId,
    filename: input.file.name,
    originalFilename: input.file.name,
    mediaType,
    buffer,
  });
}

export async function createKnowledgeDocumentFromStoredUpload(input: {
  organizationId: string;
  uploaderUserId: string;
  pathname: string[];
}) {
  assertUploadPathOwnedByUser(input.pathname, input.uploaderUserId);
  const upload = await readUpload(input.pathname);
  const filename = input.pathname.at(-1) ?? "upload";
  const mediaType = normalizeMediaType(undefined, filename);

  return createKnowledgeDocumentFromBuffer({
    organizationId: input.organizationId,
    uploaderUserId: input.uploaderUserId,
    filename,
    originalFilename: filename,
    mediaType,
    buffer: upload.buffer,
  });
}

async function createKnowledgeDocumentFromBuffer(input: {
  organizationId: string;
  uploaderUserId: string;
  projectId?: string | null;
  filename: string;
  originalFilename: string;
  mediaType: string;
  buffer: Buffer;
}) {
  const checksumSha256 = createHash("sha256")
    .update(input.buffer)
    .digest("hex");
  const existingDocument = await getKnowledgeDocumentByChecksum(
    input.organizationId,
    checksumSha256,
    input.projectId
  );

  if (existingDocument) {
    const run =
      existingDocument.status === "failed"
        ? await queueKnowledgeDocumentReindex({
            organizationId: input.organizationId,
            documentId: existingDocument.id,
            requestedByUserId: input.uploaderUserId,
          })
        : null;

    await logAdminEvent({
      organizationId: input.organizationId,
      actorUserId: input.uploaderUserId,
      category: "knowledge_documents",
      action: "reuse_upload",
      targetType: "knowledge_document",
      targetId: existingDocument.id,
      message: `Reused existing knowledge document ${existingDocument.filename} for duplicate upload.`,
      metadata: {
        mediaType: input.mediaType,
        sizeBytes: input.buffer.length,
        checksumSha256,
        reindexQueued: Boolean(run),
      },
    });

    return {
      document: existingDocument,
      run,
      deduped: true,
    };
  }

  const documentId = crypto.randomUUID();
  const storage = getStorageAdapter();
  const keyParts = buildKnowledgeDocumentObjectKey({
    organizationId: input.organizationId,
    projectId: input.projectId,
    documentId,
    filename: input.filename,
  });
  const storageKey = storage.buildObjectKey("knowledge-documents", ...keyParts);

  await storage.putObject({
    key: storageKey,
    body: input.buffer,
    contentType: input.mediaType,
    metadata: {
      organizationId: input.organizationId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      uploaderUserId: input.uploaderUserId,
    },
  });

  let document: Awaited<ReturnType<typeof createKnowledgeDocument>> | null =
    null;

  try {
    document = await createKnowledgeDocument({
      id: documentId,
      organizationId: input.organizationId,
      uploaderUserId: input.uploaderUserId,
      projectId: input.projectId,
      filename: input.filename,
      originalFilename: input.originalFilename,
      mediaType: input.mediaType,
      sizeBytes: input.buffer.length,
      checksumSha256,
      storageKey,
    });
  } catch (error) {
    if (!isChecksumConflict(error)) {
      throw error;
    }

    await storage.deleteObject(storageKey).catch(() => {
      // Best-effort orphan cleanup for duplicate upload races.
    });

    const concurrentDocument = await getKnowledgeDocumentByChecksum(
      input.organizationId,
      checksumSha256,
      input.projectId
    );

    if (!concurrentDocument) {
      throw error;
    }

    return {
      document: concurrentDocument,
      run: null,
      deduped: true,
    };
  }

  if (!document) {
    throw new Error("Knowledge document could not be created");
  }

  const run = await createKnowledgeIngestionRun({
    organizationId: input.organizationId,
    documentId: document.id,
    requestedByUserId: input.uploaderUserId,
  });

  await enqueueKnowledgeDocumentRun(run.id);

  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.uploaderUserId,
    category: "knowledge_documents",
    action: "upload",
    targetType: "knowledge_document",
    targetId: document.id,
    message: `Uploaded knowledge document ${document.filename}.`,
    metadata: {
      mediaType: input.mediaType,
      sizeBytes: input.buffer.length,
    },
  });

  return {
    document,
    run,
    deduped: false,
  };
}

export async function queueKnowledgeDocumentReindex(input: {
  organizationId: string;
  documentId: string;
  requestedByUserId?: string | null;
}) {
  const run = await createKnowledgeIngestionRun({
    organizationId: input.organizationId,
    documentId: input.documentId,
    requestedByUserId: input.requestedByUserId ?? null,
  });
  await enqueueKnowledgeDocumentRun(run.id);
  return run;
}

export async function removeKnowledgeDocument(input: {
  organizationId: string;
  documentId: string;
  actorUserId: string;
}) {
  const document = await getKnowledgeDocumentById(
    input.organizationId,
    input.documentId
  );
  if (!document) {
    throw new Error("Knowledge document not found");
  }

  const storage = getStorageAdapter();
  await storage.deleteObject(document.storageKey).catch(() => {
    // Delete is best-effort because the row graph must still be removed.
  });
  await deleteKnowledgeDocumentGraph(document.id);

  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    level: "warn",
    category: "knowledge_documents",
    action: "delete",
    targetType: "knowledge_document",
    targetId: document.id,
    message: `Deleted knowledge document ${document.filename}.`,
  });
}
