import { createHash } from "node:crypto";
import { logAdminEvent } from "@/lib/admin/logs";
import { readUpload } from "@/lib/files/storage";
import { assertUploadPathOwnedByUser } from "@/lib/files/upload-path";
import { enqueueKnowledgeDocumentRun } from "@/lib/knowledge/queue";
import { getStorageAdapter } from "@/lib/storage";
import { chunkKnowledgeDocument } from "./chunk";
import { embedKnowledgeTexts, getKnowledgeEmbeddingMode } from "./embed";
import { extractKnowledgeDocument, getKnowledgeOcrMode } from "./extract";
import { buildKnowledgeDocumentObjectKey, normalizeMediaType } from "./shared";
import {
  createKnowledgeDocument,
  createKnowledgeIngestionRun,
  deleteKnowledgeDocumentGraph,
  getKnowledgeDocumentByChecksum,
  getKnowledgeDocumentById,
  getKnowledgeIngestionRun,
  replaceKnowledgeDocumentChunks,
  updateKnowledgeDocument,
  updateKnowledgeIngestionRun,
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
  file: File;
}) {
  const mediaType = normalizeMediaType(input.file.type, input.file.name);
  const buffer = Buffer.from(await input.file.arrayBuffer());
  return createKnowledgeDocumentFromBuffer({
    organizationId: input.organizationId,
    uploaderUserId: input.uploaderUserId,
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
    checksumSha256
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
      checksumSha256
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

export async function processKnowledgeDocumentRun(runId: string) {
  const run = await getKnowledgeIngestionRun(runId);
  if (!run) {
    throw new Error("Knowledge document run not found");
  }

  const document = await getKnowledgeDocumentById(
    run.organizationId,
    run.documentId
  );
  if (!document) {
    throw new Error("Knowledge document not found");
  }

  await updateKnowledgeIngestionRun(run.id, {
    status: "running",
    stage: "extract",
    attemptCount: (run.attemptCount ?? 0) + 1,
    startedAt: new Date(),
    error: null,
  });
  await updateKnowledgeDocument(document.id, {
    status: "processing",
    error: null,
  });

  try {
    const ocrMode = getKnowledgeOcrMode();
    const embeddingMode = getKnowledgeEmbeddingMode();
    const diagnostics: Record<string, unknown> = {
      modes: {
        ocr: ocrMode,
        embedding: embeddingMode,
      },
      stageTimingsMs: {},
    };
    const storage = getStorageAdapter();
    const buffer = await storage.getObjectBuffer(document.storageKey);
    const extractStartedAt = Date.now();
    const extracted = await extractKnowledgeDocument({
      buffer,
      filename: document.originalFilename,
      mediaType: document.mediaType,
    });
    const extractDurationMs = Date.now() - extractStartedAt;
    diagnostics.warnings = extracted.warnings;
    diagnostics.metadata = extracted.metadata;
    diagnostics.stageTimingsMs = {
      ...(diagnostics.stageTimingsMs as Record<string, number>),
      extract: extractDurationMs,
    };

    await updateKnowledgeIngestionRun(run.id, {
      stage: "chunk",
      diagnostics,
    });

    const chunkStartedAt = Date.now();
    const chunks = chunkKnowledgeDocument(extracted.blocks);
    const chunkDurationMs = Date.now() - chunkStartedAt;
    diagnostics.stageTimingsMs = {
      ...(diagnostics.stageTimingsMs as Record<string, number>),
      chunk: chunkDurationMs,
    };

    if (chunks.length === 0) {
      await replaceKnowledgeDocumentChunks({
        organizationId: document.organizationId,
        documentId: document.id,
        chunks: [],
      });
      await updateKnowledgeDocument(document.id, {
        title: extracted.title ?? document.title,
        pageCount: extracted.pageCount,
        chunkCount: 0,
        extractionMetadata: {
          warnings: extracted.warnings,
          metadata: extracted.metadata,
        },
        status: "partial",
        error:
          extracted.warnings.join("; ") || "No searchable text was extracted",
      });
      await updateKnowledgeIngestionRun(run.id, {
        stage: "complete",
        status: "completed",
        diagnostics: {
          ...diagnostics,
          chunkCount: 0,
        },
        finishedAt: new Date(),
      });
      return;
    }

    await updateKnowledgeIngestionRun(run.id, {
      stage: "embed",
      diagnostics,
    });

    const embedStartedAt = Date.now();
    const embeddings = await embedKnowledgeTexts(
      chunks.map((chunk) => chunk.content)
    );
    const embedDurationMs = Date.now() - embedStartedAt;
    diagnostics.stageTimingsMs = {
      ...(diagnostics.stageTimingsMs as Record<string, number>),
      embed: embedDurationMs,
    };

    await replaceKnowledgeDocumentChunks({
      organizationId: document.organizationId,
      documentId: document.id,
      chunks: chunks.map((chunk, index) => ({
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentLength: chunk.contentLength,
        tokenCount: chunk.tokenCount,
        pageNumber: chunk.pageNumber,
        sectionTitle: chunk.sectionTitle,
        metadata: chunk.metadata,
        embedding: embeddings[index],
      })),
    });

    await updateKnowledgeDocument(document.id, {
      title: extracted.title ?? document.title ?? document.filename,
      pageCount: extracted.pageCount,
      chunkCount: chunks.length,
      extractionMetadata: {
        warnings: extracted.warnings,
        metadata: extracted.metadata,
      },
      status: extracted.warnings.length > 0 ? "partial" : "ready",
      error:
        extracted.warnings.length > 0 ? extracted.warnings.join("; ") : null,
    });

    await updateKnowledgeIngestionRun(run.id, {
      stage: "complete",
      status: "completed",
      diagnostics: {
        ...diagnostics,
        chunkCount: chunks.length,
      },
      finishedAt: new Date(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown ingestion error";
    await updateKnowledgeDocument(document.id, {
      status: "failed",
      error: message,
    });
    await updateKnowledgeIngestionRun(run.id, {
      status: "failed",
      error: message,
      diagnostics: {
        modes: {
          ocr: getKnowledgeOcrMode(),
          embedding: getKnowledgeEmbeddingMode(),
        },
      },
      finishedAt: new Date(),
    });
    throw error;
  }
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
