import { createHash } from "node:crypto";
import { logAdminEvent } from "@/lib/admin/logs";
import { readUpload } from "@/lib/files/storage";
import { assertUploadPathOwnedByUser } from "@/lib/files/upload-path";
import {
  createPublishedFileFromBuffer,
  discardUnreferencedFile,
  getFileByIdForUser,
  publishFileScope,
  revokeFileScope,
  revokeFileScopeForManagement,
} from "@/lib/files/service";
import { ensureEffectiveFileAvailability } from "@/lib/files/availability";
import { enqueueKnowledgeDocumentRun } from "@/lib/knowledge/queue";
import {
  isKnowledgeDocumentMediaTypeSupported,
  normalizeMediaType,
} from "./shared";
import {
  createOrGetKnowledgeDocumentByChecksumSerialized,
  createOrGetKnowledgeDocumentByFileScope,
  createOrReuseKnowledgeIngestionRun,
  deleteKnowledgeDocumentGraph,
  getKnowledgeDocumentByChecksum,
  getKnowledgeDocumentByFileScope,
  getKnowledgeDocumentById,
} from "./store";

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

export async function publishFileToKnowledge(input: {
  organizationId: string;
  uploaderUserId: string;
  fileId: string;
  projectId?: string | null;
}) {
  const file = await getFileByIdForUser({
    fileId: input.fileId,
    organizationId: input.organizationId,
    userId: input.uploaderUserId,
  });
  if (file.lifecycleState !== "ready" || !file.sha256) {
    throw new Error("Only ready files can be published to Knowledge.");
  }
  await ensureEffectiveFileAvailability({
    fileId: file.id,
    lifecycleState: file.lifecycleState,
    blobId: file.blobId,
    objectKey: file.objectKey,
    availabilityStatus: file.availabilityStatus,
    blobDeletedAt: file.blobDeletedAt,
  });
  if (!isKnowledgeDocumentMediaTypeSupported(
    file.detectedMediaType ?? file.declaredMediaType ?? "",
    file.filename,
  )) {
    throw new Error("This file type is not supported for Knowledge.");
  }
  await publishFileScope({
    fileId: file.id,
    organizationId: input.organizationId,
    userId: input.uploaderUserId,
    scope: input.projectId ? "project" : "organization",
    projectId: input.projectId ?? undefined,
  });
  const existing = await getKnowledgeDocumentByFileScope({
    organizationId: input.organizationId,
    fileId: file.id,
    projectId: input.projectId,
  });
  if (existing) {
    const run = await ensureKnowledgeDocumentIngestion({
      document: existing,
      requestedByUserId: input.uploaderUserId,
    });
    return { document: existing, run, deduped: true };
  }
  const documentResult = await createOrGetKnowledgeDocumentByFileScope({
    id: crypto.randomUUID(),
    fileId: file.id,
    organizationId: input.organizationId,
    uploaderUserId: input.uploaderUserId,
    projectId: input.projectId,
    filename: file.filename,
    originalFilename: file.filename,
    mediaType: file.detectedMediaType ?? file.declaredMediaType ?? "application/octet-stream",
    sizeBytes: file.sizeBytes,
    checksumSha256: file.sha256,
    storageKey: file.objectKey,
  });
  const { document } = documentResult;
  let run;
  if (documentResult.created) {
    ({ run } = await createOrReuseKnowledgeIngestionRun({
      organizationId: input.organizationId,
      documentId: document.id,
      requestedByUserId: input.uploaderUserId,
    }));
    await enqueueKnowledgeDocumentRun({
      runId: run.id,
      documentId: document.id,
    });
  } else {
    run = await ensureKnowledgeDocumentIngestion({
      document,
      requestedByUserId: input.uploaderUserId,
    });
  }
  return { document, run, deduped: !documentResult.created };
}

export async function revokeFileFromKnowledge(input: {
  organizationId: string;
  userId: string;
  fileId: string;
  projectId?: string | null;
}) {
  await revokeFileScope({
    fileId: input.fileId,
    organizationId: input.organizationId,
    userId: input.userId,
    scope: input.projectId ? "project" : "organization",
    projectId: input.projectId ?? undefined,
  });
  const document = await getKnowledgeDocumentByFileScope({
    organizationId: input.organizationId,
    fileId: input.fileId,
    projectId: input.projectId,
  });
  if (document) await deleteKnowledgeDocumentGraph(document.id);
  await discardUnreferencedFile(input.fileId).catch(() => {});
  return { revoked: true, documentId: document?.id ?? null };
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
    const run = await ensureKnowledgeDocumentIngestion({
      document: existingDocument,
      requestedByUserId: input.uploaderUserId,
    });

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
  const file = await createPublishedFileFromBuffer({
    organizationId: input.organizationId,
    uploaderUserId: input.uploaderUserId,
    projectId: input.projectId,
    filename: input.filename,
    declaredMediaType: input.mediaType,
    buffer: input.buffer,
  });

  const documentResult = await createOrGetKnowledgeDocumentByChecksumSerialized({
    id: documentId,
    fileId: file.id,
    organizationId: input.organizationId,
    uploaderUserId: input.uploaderUserId,
    projectId: input.projectId,
    filename: input.filename,
    originalFilename: input.originalFilename,
    mediaType: input.mediaType,
    sizeBytes: input.buffer.length,
    checksumSha256,
    storageKey: file.objectKey,
  });
  const { document } = documentResult;
  if (!documentResult.created) {
    await discardUnreferencedFile(file.id, { removeScopeGrants: true }).catch(() => {});
    const run = await ensureKnowledgeDocumentIngestion({
      document,
      requestedByUserId: input.uploaderUserId,
    });
    return {
      document,
      run,
      deduped: true,
    };
  }

  const { run } = await createOrReuseKnowledgeIngestionRun({
    organizationId: input.organizationId,
    documentId: document.id,
    requestedByUserId: input.uploaderUserId,
  });

  await enqueueKnowledgeDocumentRun({
    runId: run.id,
    documentId: document.id,
  });

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
  const result = await createOrReuseKnowledgeIngestionRun({
    organizationId: input.organizationId,
    documentId: input.documentId,
    requestedByUserId: input.requestedByUserId ?? null,
  });
  await enqueueKnowledgeDocumentRun({
    runId: result.run.id,
    documentId: input.documentId,
  });
  return result;
}

async function ensureKnowledgeDocumentIngestion(input: {
  document: {
    id: string;
    organizationId: string;
    status: string;
  };
  requestedByUserId?: string | null;
}) {
  if (input.document.status === "ready" || input.document.status === "partial") {
    return null;
  }
  const { run } = await queueKnowledgeDocumentReindex({
    organizationId: input.document.organizationId,
    documentId: input.document.id,
    requestedByUserId: input.requestedByUserId,
  });
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

  await revokeFileScopeForManagement({
    fileId: document.fileId,
    organizationId: input.organizationId,
    scope: document.scope,
    projectId: document.projectId,
  });
  await deleteKnowledgeDocumentGraph(document.id);
  await discardUnreferencedFile(document.fileId).catch(() => {});

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
